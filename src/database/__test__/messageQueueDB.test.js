jest.mock('react-native');
jest.mock('react-native-quick-sqlite');

import { getDB } from '../db';
import {
  claimPendingQueue,
  addToQueueDetailed,
  markAsSent,
  QUEUE_STATUS,
} from '../messageQueueDB';

/** Directly inserts a queue row with a controllable created_at/status,
 * bypassing addToQueueDetailed's dedup rules — used to set up fixtures
 * that would be hard/impossible to reach through the public API alone
 * (e.g. a row that's been stuck in CLAIMED for 5 minutes). */
const insertRawQueueRow = ({ id, contactId, templateId, status, minutesAgo = 0 }) => {
  const db = getDB();
  db.execute(
    `INSERT INTO message_queue (id, contact_id, template_id, platform_id, status, created_at)
     VALUES (?, ?, ?, 'sms', ?, datetime('now', '-${minutesAgo} minutes'));`,
    [id, contactId, templateId, status],
  );
};

const getRow = (id) => {
  const db = getDB();
  return db.execute('SELECT * FROM message_queue WHERE id = ?;', [id]).rows._array[0];
};

describe('claimPendingQueue', () => {
  it('claims PENDING rows, moving them to CLAIMED and returning them', () => {
    insertRawQueueRow({ id: 'q1', contactId: 'c1', templateId: 't1', status: 'PENDING' });
    insertRawQueueRow({ id: 'q2', contactId: 'c2', templateId: 't1', status: 'PENDING' });

    const claimed = claimPendingQueue('run-1');

    expect(claimed.map((r) => r.id).sort()).toEqual(['q1', 'q2']);
    expect(getRow('q1').status).toBe(QUEUE_STATUS.CLAIMED);
    expect(getRow('q2').status).toBe(QUEUE_STATUS.CLAIMED);
  });

  it('does not touch rows that are already SENT or FAILED', () => {
    insertRawQueueRow({ id: 'q3', contactId: 'c3', templateId: 't1', status: 'SENT' });
    insertRawQueueRow({ id: 'q4', contactId: 'c4', templateId: 't1', status: 'FAILED' });

    const claimed = claimPendingQueue('run-2');

    expect(claimed.map((r) => r.id)).not.toEqual(expect.arrayContaining(['q3', 'q4']));
    expect(getRow('q3').status).toBe('SENT');
    expect(getRow('q4').status).toBe('FAILED');
  });

  describe('regression: stale CLAIMED rows (Problem 2 & 4 — resend of already-handled messages)', () => {
    it('recovers a row stuck in CLAIMED for >2 minutes into FAILED, and does NOT return it for resending', () => {
      // Simulates a previous run that claimed this row (CLAIMED) and
      // then crashed/got killed before it could reach SENT or FAILED —
      // exactly what happened when the app was killed mid-send.
      insertRawQueueRow({
        id: 'stuck-1', contactId: 'c5', templateId: 't1', status: 'CLAIMED', minutesAgo: 5,
      });
      // A genuinely new item that should still be claimed normally.
      insertRawQueueRow({ id: 'fresh-1', contactId: 'c6', templateId: 't1', status: 'PENDING' });

      const claimed = claimPendingQueue('run-3');

      // The stuck row must NOT come back for another send attempt.
      expect(claimed.map((r) => r.id)).not.toContain('stuck-1');
      // It should have been recovered to FAILED with a clear reason,
      // visible in the Failed tab for a deliberate manual retry.
      const recovered = getRow('stuck-1');
      expect(recovered.status).toBe('FAILED');
      expect(recovered.error_reason).toBe('STUCK_CLAIMED_TIMEOUT');

      // The genuinely new item is unaffected and gets claimed as normal.
      expect(claimed.map((r) => r.id)).toContain('fresh-1');
      expect(getRow('fresh-1').status).toBe(QUEUE_STATUS.CLAIMED);
    });

    it('does NOT recover a row that has only just started processing (well under the 2-minute threshold)', () => {
      insertRawQueueRow({
        id: 'recent-claimed', contactId: 'c7', templateId: 't1', status: 'CLAIMED', minutesAgo: 0,
      });

      claimPendingQueue('run-4');

      // Still legitimately in-flight — must be left alone, not force-failed.
      expect(getRow('recent-claimed').status).toBe('CLAIMED');
    });

    it('regression guard: demonstrates the OLD buggy query would have resent a stale PROCESSING row', () => {
      insertRawQueueRow({
        id: 'stuck-old-bug', contactId: 'c8', templateId: 't1', status: 'PROCESSING', minutesAgo: 10,
      });
      insertRawQueueRow({ id: 'fresh-old-bug', contactId: 'c9', templateId: 't1', status: 'PENDING' });

      // This is the exact query the old, buggy claimPendingQueue used —
      // select ALL rows currently PROCESSING, not just the ones just
      // claimed. Kept here only as a live regression check.
      const db = getDB();
      db.execute(`UPDATE message_queue SET status = 'CLAIMED' WHERE status = 'PENDING';`);
      const oldBuggyResult = db.execute(
        `SELECT * FROM message_queue WHERE status = 'CLAIMED' ORDER BY created_at ASC;`,
      ).rows._array;

      // The old query WOULD have handed back the stale row too — proving
      // why it caused already-handled messages to be resent.
      expect(oldBuggyResult.map((r) => r.id)).toEqual(
        expect.arrayContaining(['stuck-old-bug', 'fresh-old-bug']),
      );

      // Reset this probe's side effects, then confirm the REAL function
      // does not have this problem.
      db.execute(`UPDATE message_queue SET status = 'PENDING' WHERE id = 'fresh-old-bug';`);
      db.execute(`UPDATE message_queue SET status = 'CLAIMED' WHERE id = 'stuck-old-bug';`);

      const claimed = claimPendingQueue('run-5');
      expect(claimed.map((r) => r.id)).not.toContain('stuck-old-bug');
    });
  });
});

describe('addToQueueDetailed dedup rules', () => {
  it('queues a new contact+template pair', () => {
    const result = addToQueueDetailed('contact-a', 'template-a', 'sms');
    expect(result).toEqual({ added: true, reason: 'QUEUED' });
  });

  it('refuses a duplicate while one is already PENDING/CLAIMED for the same pair', () => {
    addToQueueDetailed('contact-b', 'template-b', 'sms');
    const second = addToQueueDetailed('contact-b', 'template-b', 'sms');
    expect(second).toEqual({ added: false, reason: 'ALREADY_PENDING' });
  });

  it('refuses re-queueing a pair that was already SENT within the last 30 days', () => {
    addToQueueDetailed('contact-c', 'template-c', 'sms');

    const db = getDB();
    const row = db.execute(
      `SELECT id FROM message_queue WHERE contact_id = ? AND template_id = ?;`,
      ['contact-c', 'template-c'],
    ).rows._array[0];

    markAsSent(row.id);

    const second = addToQueueDetailed('contact-c', 'template-c', 'sms');
    expect(second).toEqual({ added: false, reason: 'ALREADY_SENT_RECENTLY' });
  });

  it('refuses re-queueing a pair that FAILED within the last 24 hours', () => {
    insertRawQueueRow({
      id: 'failed-1',
      contactId: 'contact-d',
      templateId: 'template-d',
      status: 'FAILED',
      minutesAgo: 60,
    });

    const result = addToQueueDetailed('contact-d', 'template-d', 'sms');

    expect(result).toEqual({
      added: false,
      reason: 'RECENTLY_FAILED',
    });

    const db = getDB();
    const rows = db.execute(
      `SELECT * FROM message_queue
       WHERE contact_id = ? AND template_id = ?;`,
      ['contact-d', 'template-d'],
    ).rows._array;

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FAILED');
  });

  it('allows re-queueing a pair that FAILED more than 24 hours ago', () => {
    const db = getDB();

    db.execute(
      `INSERT INTO message_queue
        (id, contact_id, template_id, platform_id, status, created_at)
       VALUES
        (?, ?, ?, 'sms', 'FAILED', datetime('now', '-25 hours'));`,
      ['failed-old-1', 'contact-e', 'template-e'],
    );

    const result = addToQueueDetailed('contact-e', 'template-e', 'sms');

    expect(result).toEqual({
      added: true,
      reason: 'QUEUED',
    });

    const rows = db.execute(
      `SELECT * FROM message_queue
       WHERE contact_id = ? AND template_id = ?
       ORDER BY created_at ASC;`,
      ['contact-e', 'template-e'],
    ).rows._array;

    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[1].status).toBe('PENDING');
  });
});
