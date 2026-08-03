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

export const getTask = (name) => TASKS[name] ?? null;
