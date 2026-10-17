// What each person thought of a recipe: liked it, or not again.
//
// One rating per person per recipe, the latest standing. They're asked for
// after eating a planned recipe, and they steer what's suggested next: AI
// orders and the assistant lean to what was liked and away from the rest.

export function createRatingTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_ratings (
    userId TEXT NOT NULL,
    recipeId TEXT NOT NULL,
    -- 1 liked it, -1 not again.
    rating INTEGER NOT NULL,
    ratedAt TEXT NOT NULL,
    PRIMARY KEY (userId, recipeId)
  )`);
}

export class RatingError extends Error {
  status = 400;
}

/** Records a rating; 0 takes it back. */
export function rate(db, userId, recipeId, rating) {
  if (!db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(recipeId)) {
    throw Object.assign(new RatingError('No such recipe.'), { status: 404 });
  }
  const value = Number(rating);
  if (![1, -1, 0].includes(value)) throw new RatingError('rating must be 1, -1 or 0');
  if (value === 0) {
    db.prepare('DELETE FROM recipe_ratings WHERE userId = ? AND recipeId = ?').run(userId, recipeId);
    return;
  }
  db.prepare(
    `INSERT INTO recipe_ratings (userId, recipeId, rating, ratedAt) VALUES (?, ?, ?, ?)
     ON CONFLICT (userId, recipeId) DO UPDATE SET rating = excluded.rating, ratedAt = excluded.ratedAt`,
  ).run(userId, recipeId, value, new Date().toISOString());
}

/** Everyone's ratings of a recipe, and this person's own. */
export function ratingsOf(db, recipeId, userId) {
  const rows = db
    .prepare(
      `SELECT r.rating, u.username, r.userId FROM recipe_ratings r JOIN users u ON u.id = r.userId
       WHERE r.recipeId = ? ORDER BY u.createdAt`,
    )
    .all(recipeId);
  return {
    likes: rows.filter((r) => r.rating > 0).length,
    dislikes: rows.filter((r) => r.rating < 0).length,
    yours: rows.find((r) => r.userId === userId)?.rating ?? 0,
    people: rows.map(({ username, rating }) => ({ username, rating })),
  };
}

/**
 * Recipes this person had a portion of in the last few days, up to today,
 * that they haven't rated: what to ask about. Newest first, three at most.
 */
export function toRate(db, userId, today, { days = 3 } = {}) {
  const from = new Date(`${today}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - days);
  return db
    .prepare(
      `SELECT r.id AS recipeId, r.name, r.imageUrl, MAX(i.date) AS date
       FROM meal_plan_items i
       JOIN meal_plan_portions p ON p.itemId = i.id AND p.userId = ?
       JOIN recipes r ON r.id = i.recipeId
       WHERE i.date BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM recipe_ratings x WHERE x.userId = ? AND x.recipeId = r.id)
       GROUP BY r.id ORDER BY date DESC LIMIT 3`,
    )
    .all(userId, from.toISOString().slice(0, 10), today, userId);
}

/** The household's liked and disliked recipe names, for a model to go by. */
export function householdTaste(db) {
  const rows = db
    .prepare(
      `SELECT r.name, SUM(x.rating > 0) AS likes, SUM(x.rating < 0) AS dislikes
       FROM recipe_ratings x JOIN recipes r ON r.id = x.recipeId GROUP BY r.id`,
    )
    .all();
  return {
    liked: rows.filter((r) => r.likes > r.dislikes).map((r) => r.name),
    disliked: rows.filter((r) => r.dislikes >= r.likes && r.dislikes > 0).map((r) => r.name),
  };
}
