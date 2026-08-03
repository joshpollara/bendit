// All user-facing copy in one place.

export const STRINGS = {
  underBudget: (kcal: string) => `You're ${kcal} calories under budget. Nice.`,
  overBudget: (kcal: string) => `You're ${kcal} calories over budget.`,
  onBudget: 'Right on budget.',
  emptyMeal: 'Nothing logged yet.',
  emptyExercise: 'No exercise logged today.',
  budgetReveal: (kcal: string) => `Your daily budget is ${kcal} calories.`,
  noWeights: 'Log your first weight to start the graph.',
  goalReached: 'You reached your goal weight. Congratulations!',
  aggressiveRate:
    'That rate puts your budget below a safe minimum, so we raised it to the floor. Consider a gentler pace.',
  noResults: 'No foods found. Try another search or create a custom food.',
  splash: 'A simpler way to track your day.',
};
