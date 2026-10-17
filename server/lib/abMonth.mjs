// An A/B month: a person's goal that a share of what they eat in a month is
// food graded Nutri-Score A or B.
//
// The share is of calories, not weight. Every log entry has calories, while
// many have no weight — a recipe serving, an estimate — and by weight a
// watery salad would outweigh the biscuit eaten with it. Food with no grade
// (no nutrition label, a quick estimate) is left out of the share rather than
// counted either way, and how much of the day could be graded is reported
// beside it, so a share resting on a third of the day can be seen as such.

export function createAbTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ab_goals (
    userId TEXT NOT NULL,
    month TEXT NOT NULL,
    -- 0–1: the share of graded calories to come from A and B foods.
    target REAL NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY (userId, month)
  )`);
}

export class AbError extends Error {
  status = 400;
}

const isMonth = (m) => typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export function setGoal(db, userId, { month, target }) {
  if (!isMonth(month)) throw new AbError('month must be YYYY-MM');
  const share = Number(target);
  if (!(share >= 0.1 && share <= 1)) throw new AbError('target must be between 10% and 100%');
  db.prepare(
    `INSERT INTO ab_goals (userId, month, target, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT (userId, month) DO UPDATE SET target = excluded.target`,
  ).run(userId, month, Math.round(share * 100) / 100, new Date().toISOString());
}

export function clearGoal(db, userId, month) {
  db.prepare('DELETE FROM ab_goals WHERE userId = ? AND month = ?').run(userId, month);
}

const share = (part, whole) => (whole > 0 ? part / whole : null);

/**
 * A month for one person: the goal if there is one, each logged day's share,
 * and the month so far. `gradeOf(row)` grades a log row joined to its food.
 */
export function abMonth(db, userId, month, { rows, gradeOf }) {
  if (!isMonth(month)) throw new AbError('month must be YYYY-MM');
  const goal = db.prepare('SELECT target FROM ab_goals WHERE userId = ? AND month = ?').get(userId, month) ?? null;

  const byDay = new Map();
  for (const row of rows) {
    const calories = row.caloriesCached > 0 ? row.caloriesCached : 0;
    if (!calories) continue;
    const day = byDay.get(row.date) ?? { date: row.date, calories: 0, graded: 0, ab: 0 };
    day.calories += calories;
    const grade = gradeOf(row);
    if (grade) {
      day.graded += calories;
      if (grade === 'A' || grade === 'B') day.ab += calories;
    }
    byDay.set(row.date, day);
  }

  const days = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      share: share(d.ab, d.graded),
      covered: share(d.graded, d.calories) ?? 0,
      calories: Math.round(d.calories),
    }));
  const total = [...byDay.values()].reduce(
    (sum, d) => ({ calories: sum.calories + d.calories, graded: sum.graded + d.graded, ab: sum.ab + d.ab }),
    { calories: 0, graded: 0, ab: 0 },
  );
  return {
    month,
    goal: goal ? { target: goal.target } : null,
    days,
    total: {
      share: share(total.ab, total.graded),
      covered: share(total.graded, total.calories) ?? 0,
      daysOnTarget: goal ? days.filter((d) => d.share != null && d.share >= goal.target).length : null,
      daysLogged: days.length,
    },
  };
}
