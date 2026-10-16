import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAssistant } from './assistant.mjs';
import { createMealPlanTables } from './mealPlan.mjs';
import { createRecipeTables } from './recipeStore.mjs';
import { createUser, createUsersTable } from './users.mjs';

let db;
let ann;

beforeEach(() => {
  db = new Database(':memory:');
  createUsersTable(db);
  createRecipeTables(db);
  createMealPlanTables(db);
  db.exec(`
    CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT, brand TEXT, servingLabel TEXT, servingGrams REAL,
      caloriesPerServing REAL, protein REAL, carbs REAL, fat REAL);
    CREATE TABLE food_log (id TEXT PRIMARY KEY, date TEXT, meal TEXT, foodId TEXT, servings REAL,
      caloriesCached REAL, label TEXT, estimated INTEGER, proteinCached REAL, planItemId TEXT, userId TEXT);
    CREATE TABLE vision_requests (id TEXT PRIMARY KEY, createdAt TEXT, task TEXT, promptVersion TEXT,
      model TEXT, imageHash TEXT, imageBytes INTEGER, status TEXT, errorCode TEXT, latencyMs INTEGER,
      inputTokens INTEGER, outputTokens INTEGER, totalTokens INTEGER, userId TEXT);
    INSERT INTO foods VALUES ('yogurt', 'Greek yogurt', NULL, '170 g', 170, 100, 17, 6, 0.7);
  `);
  ann = createUser(db, 'ann', 'password-ann').id;
});

const picnic = { status: () => ({ connected: false }) };

/** A model that answers from a script, one turn per call, and records what it was sent. */
function scriptedModel(turns) {
  const sent = [];
  return {
    model: 'test-model',
    configured: true,
    sent,
    async generate({ system, contents, tools }) {
      sent.push({ system, contents: structuredClone(contents), tools });
      const parts = turns.shift();
      if (!parts) throw new Error('script ran out');
      return {
        content: { role: 'model', parts },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        latencyMs: 5,
      };
    },
  };
}

const say = (text) => [{ text }];
const call = (name, args, id) => [{ functionCall: { name, args, ...(id ? { id } : {}) } }];
const context = { today: '2026-10-16', budget: 1800, targets: { protein: 120 } };

describe('the assistant', () => {
  it('answers, and logs the call against the assistant', async () => {
    const model = scriptedModel([say('Hello.')]);
    const assistant = createAssistant({ db, picnic, model });
    const state = await assistant.send(ann, 'hi', context);
    expect(state.log).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'Hello.' },
    ]);
    expect(model.sent[0].system).toMatch(/talking to ann/);
    expect(model.sent[0].system).toMatch(/1800 calories a day, 120 g protein/);
    expect(db.prepare('SELECT task, status, inputTokens FROM vision_requests').all()).toEqual([
      { task: 'assistant', status: 'ok', inputTokens: 100 },
    ]);
  });

  it('runs a read straight away and gives the model the result', async () => {
    db.prepare(`INSERT INTO food_log VALUES ('e1', '2026-10-16', 'breakfast', 'yogurt', 1, 100, NULL, 0, NULL, NULL, ?)`).run(ann);
    const model = scriptedModel([call('get_day', { date: '2026-10-16' }, 'c1'), say('100 calories so far.')]);
    const assistant = createAssistant({ db, picnic, model });
    await assistant.send(ann, 'how am I doing', context);
    const reply = model.sent[1].contents.at(-1);
    expect(reply.role).toBe('user');
    expect(reply.parts[0].functionResponse).toMatchObject({
      name: 'get_day',
      id: 'c1',
      response: { totals: { calories: 100 } },
    });
  });

  it('proposes a change and waits; nothing happens until it is approved', async () => {
    const model = scriptedModel([
      call('log_food', { date: '2026-10-16', meal: 'snacks', foodId: 'yogurt', servings: 2 }),
      say('Logged.'),
    ]);
    const assistant = createAssistant({ db, picnic, model });
    const waiting = await assistant.send(ann, 'log two yogurts', context);
    expect(waiting.waiting).toBe(true);
    const action = waiting.log.find((e) => e.role === 'action');
    expect(action).toMatchObject({ status: 'pending', text: expect.stringMatching(/Log 2 × 170 g Greek yogurt.*200 cal/) });
    expect(db.prepare('SELECT COUNT(*) AS n FROM food_log').get().n).toBe(0);
    await expect(assistant.send(ann, 'and another', context)).rejects.toThrow(/Approve or skip/);

    const done = await assistant.decide(ann, { [action.id]: 'approve' });
    expect(done.waiting).toBe(false);
    expect(done.log.find((e) => e.id === action.id).status).toBe('done');
    expect(db.prepare('SELECT userId, servings, caloriesCached FROM food_log').get()).toEqual({
      userId: ann,
      servings: 2,
      caloriesCached: 200,
    });
    expect(done.log.at(-1)).toEqual({ role: 'assistant', text: 'Logged.' });
  });

  it('tells the model when a proposal was skipped', async () => {
    const model = scriptedModel([
      call('log_food', { date: '2026-10-16', meal: 'snacks', foodId: 'yogurt', servings: 1 }),
      say('Okay, not logged.'),
    ]);
    const assistant = createAssistant({ db, picnic, model });
    const waiting = await assistant.send(ann, 'log a yogurt', context);
    const action = waiting.log.find((e) => e.role === 'action');
    const done = await assistant.decide(ann, { [action.id]: 'skip' });
    expect(done.log.find((e) => e.id === action.id).status).toBe('skipped');
    expect(model.sent[1].contents.at(-1).parts[0].functionResponse.response).toMatchObject({ skipped: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM food_log').get().n).toBe(0);
  });

  it('turns a proposal that names nothing real into an error for the model, not a card', async () => {
    const model = scriptedModel([
      call('log_food', { date: '2026-10-16', meal: 'snacks', foodId: 'made-up', servings: 1 }),
      say('I could not find that.'),
    ]);
    const assistant = createAssistant({ db, picnic, model });
    const state = await assistant.send(ann, 'log something', context);
    expect(state.waiting).toBe(false);
    expect(state.log.some((e) => e.role === 'action')).toBe(false);
    expect(model.sent[1].contents.at(-1).parts[0].functionResponse.response).toEqual({ error: 'No such food.' });
  });

  it('answers a tool that does not exist with an error', async () => {
    const model = scriptedModel([call('checkout', {}), say('I cannot pay.')]);
    const assistant = createAssistant({ db, picnic, model });
    await assistant.send(ann, 'pay for it', context);
    expect(model.sent[1].contents.at(-1).parts[0].functionResponse.response.error).toMatch(/no tool called checkout/);
  });

  it('offers no way to check out or pay', async () => {
    const model = scriptedModel([say('ok')]);
    await createAssistant({ db, picnic, model }).send(ann, 'hi', context);
    const names = model.sent[0].tools.map((t) => t.name);
    expect(names.some((n) => /checkout|pay|confirm/.test(n))).toBe(false);
  });

  it('replaces a question the model never answered instead of stacking another after it', async () => {
    let fail = true;
    const model = scriptedModel([say('Here you go.')]);
    const flaky = {
      ...model,
      generate: async (args) => {
        if (fail) {
          fail = false;
          throw Object.assign(new Error('slow'), { name: 'VisionError', code: 'timeout' });
        }
        return model.generate(args);
      },
    };
    const assistant = createAssistant({ db, picnic, model: flaky });
    await expect(assistant.send(ann, 'first try', context)).rejects.toMatchObject({ code: 'timeout' });
    const state = await assistant.send(ann, 'second try', context);
    expect(model.sent[0].contents).toEqual([{ role: 'user', parts: [{ text: 'second try' }] }]);
    expect(state.log).toEqual([
      { role: 'user', text: 'second try' },
      { role: 'assistant', text: 'Here you go.' },
    ]);
  });

  it('stops at its own daily ceiling', async () => {
    const model = scriptedModel([say('one'), say('two')]);
    const assistant = createAssistant({ db, picnic, model, dailyLimit: 1 });
    await assistant.send(ann, 'first', context);
    await expect(assistant.send(ann, 'second', context)).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('keeps each person’s conversation to themselves, and starts over when asked', async () => {
    const ben = createUser(db, 'ben', 'password-ben').id;
    const assistant = createAssistant({ db, picnic, model: scriptedModel([say('Hi ann.')]) });
    await assistant.send(ann, 'hi', context);
    expect(assistant.state(ben).log).toEqual([]);
    expect(assistant.reset(ann).log).toEqual([]);
  });
});
