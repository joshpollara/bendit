// What the model is asked to do, and what shape the answer has to come back in.
//
// Prompts and schemas live on the server, not the client. The client names a
// task; it can't dictate the prompt. That keeps a stolen session from turning
// this endpoint into a general-purpose model proxy, and it means a prompt can
// be changed without shipping a new client.
//
// Every task carries a version. It goes into the request log, so when a prompt
// changes it's possible to tell afterwards which results came from which
// wording — otherwise "did that change help?" is unanswerable.

/** The nutrient block, as printed. Anything absent from the label stays null. */
const NUTRIENTS = {
  type: 'object',
  properties: {
    calories: { type: 'number', nullable: true, description: 'Energy in kcal, as printed' },
    energyKj: { type: 'number', nullable: true, description: 'Energy in kJ, if printed' },
    protein: { type: 'number', nullable: true, description: 'Grams' },
    carbs: { type: 'number', nullable: true, description: 'Grams of total carbohydrate' },
    sugar: { type: 'number', nullable: true, description: 'Grams' },
    fat: { type: 'number', nullable: true, description: 'Grams of total fat' },
    satFat: { type: 'number', nullable: true, description: 'Grams of saturated fat' },
    fiber: { type: 'number', nullable: true, description: 'Grams' },
    sodiumMg: { type: 'number', nullable: true, description: 'Milligrams of sodium' },
    alcohol: {
      type: 'number',
      nullable: true,
      description: 'Grams of alcohol, if the label states it — drinks often do',
    },
    saltG: { type: 'number', nullable: true, description: 'Grams of salt, as European labels print' },
  },
  required: ['calories', 'protein', 'carbs', 'fat'],
};

export const TASKS = {
  label: {
    version: '2', // added alcohol, which the energy check needs for drinks
    /**
     * European labels lead with a per-100g column and often add a per-portion
     * one; American labels give per-serving only. Both columns are captured
     * separately rather than merged, because which one you're looking at
     * changes the number by a factor of three.
     */
    prompt: [
      'You are reading a nutrition information panel from a photograph of food packaging.',
      '',
      'Transcribe only what is printed. Do not estimate, infer, or fill in typical values.',
      'If a value is not printed, or you cannot read it clearly, use null.',
      '',
      'Labels often have two columns: one per 100 g (or 100 ml) and one per portion.',
      'Put each in its own field. If there is only one column, work out which it is from',
      'its heading and leave the other null.',
      '',
      'Energy: record kcal in calories and kJ in energyKj. Do not convert between them.',
      'Record sodium in mg and salt in g, whichever the label prints — do not convert.',
      'For a drink, record alcohol in grams if stated: it carries calories no macro accounts for.',
      'basis is "ml" only if the panel is measured by volume, otherwise "g".',
      'servingLabel is the portion as written, e.g. "1 biscuit (12,5 g)" or "2/3 cup".',
      '',
      'Set confidence to "low" if the photo is blurred, cropped, or you are unsure of a',
      'digit; the entry will be shown for correction before anything is saved.',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', nullable: true, description: 'Product name, if visible' },
        brand: { type: 'string', nullable: true },
        basis: { type: 'string', enum: ['g', 'ml'], description: 'Whether the panel measures by weight or volume' },
        servingLabel: { type: 'string', nullable: true },
        servingGrams: {
          type: 'number',
          nullable: true,
          description: 'The portion in grams or ml, if the label states it',
        },
        servingsPerContainer: { type: 'number', nullable: true },
        per100: { ...NUTRIENTS, nullable: true, description: 'The per-100g or per-100ml column' },
        perServing: { ...NUTRIENTS, nullable: true, description: 'The per-portion column' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['basis', 'confidence'],
    },
  },
};

/**
 * A photographed meal. The model names the foods and estimates how much of
 * each is on the plate — and stops there.
 *
 * There is no field in this schema for calories or macros, deliberately. A
 * model asked for "350 kcal" will produce a plausible number by writing one
 * down; the same food looked up in the database gives a number that came from
 * a laboratory and is the same every time you ask. Identification is the part
 * models are good at, so that is the part they are asked for.
 */
TASKS.meal = {
  version: '1',
  prompt: [
    'You are looking at a photograph of a meal, to help someone log what they ate.',
    '',
    'List each distinct food you can see. For each one give:',
    '  • name — what the food is, in plain words someone would search for:',
    '    "grilled chicken breast", "white rice", "olive oil". Name the food, not',
    '    the dish, when a dish is really several foods on a plate.',
    '  • grams — how much of it is there, as edible weight. Estimate against the',
    '    plate, cutlery, or hand in the photo if any are visible.',
    '  • confidence — "high" if both the food and the amount are clear, "medium"',
    '    if the amount is a judgement call, "low" if you are unsure what it is.',
    '',
    'Do not give calories, protein, carbohydrate, fat or any other nutrition',
    'figure. They are looked up from the food name, not taken from you.',
    '',
    'Ignore anything not eaten: the plate, cutlery, packaging, the table.',
    'Combine what is genuinely one food — a scattering of peas is one item.',
    'If the photo is not of food, return an empty list.',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Each distinct food on the plate',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plain searchable food name' },
            grams: { type: 'number', description: 'Estimated edible weight in grams' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['name', 'grams', 'confidence'],
        },
      },
    },
    required: ['items'],
  },
};

/**
 * A recipe, read from a photograph of a page or from the text of one that
 * published no structured data.
 *
 * The model transcribes and counts; it does not weigh or price. Ingredient
 * lines come back as written, because the parser turns "1½ cups" into grams
 * more reliably than any prose about it, and the calories come from the food
 * database as they do everywhere else.
 */
TASKS.recipe = {
  version: '1',
  prompt: [
    'You are reading a recipe, either from a photograph of a page or from the text of a web page.',
    '',
    'Return:',
    '  • name — what the recipe is called.',
    '  • ingredients — every ingredient line, exactly as written, in order. Keep the',
    '    quantities and units as printed: "1½ cups plain flour", not "flour".',
    '  • instructions — the method, one step per line, or null if there is none.',
    '  • servings — how many portions it makes, if the recipe says so.',
    '  • servingsStated — true only if the recipe actually says. If it does not,',
    '    estimate from the quantities and set this false.',
    '  • servingsReasoning — one short sentence on where the number came from.',
    '',
    'Do not give calories or any other nutrition figure. Those are looked up from the',
    'ingredients, not taken from you.',
    'Ignore anything that is not the recipe: adverts, comments, the writer’s holiday.',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      ingredients: {
        type: 'array',
        description: 'Ingredient lines, as written',
        items: { type: 'string' },
      },
      instructions: { type: 'string', nullable: true },
      servings: { type: 'number', nullable: true, description: 'Portions the recipe makes' },
      servingsStated: { type: 'boolean', description: 'True only if the recipe says so itself' },
      servingsReasoning: { type: 'string', nullable: true },
    },
    required: ['name', 'ingredients', 'servingsStated'],
  },
};

export const getTask = (name) => TASKS[name] ?? null;
