import { describe, expect, it } from 'vitest';
import { fruitVegShare } from './fruitVeg.mjs';

// Ingredient lists as Picnic shows them, from real products.
describe('fruit and vegetables from an ingredient list', () => {
  it('adds up the percentages stated for fruit, vegetables and legumes', () => {
    expect(fruitVegShare('Ingrediënten: Appelsap (100%)')).toBe(100);
    expect(fruitVegShare('Ingrediënten: 51% kikkererwten, raapolie, 16% SESAMPASTA (SESAMZAAD, zout), water, knoflook')).toBe(51);
    expect(
      fruitVegShare('Ingrediënten: appelsap 59%, drakenfruitpuree 30%, passievruchtensap 6%, bananenpuree 5%, anti-oxidant: ascorbinezuur'),
    ).toBe(100);
    expect(fruitVegShare('81% avocado, 10% tomaat, groene chilipeper, ui, suiker, knoflook, citroensap, zout')).toBe(91);
  });

  it("counts a group's stated share, not its parts' again", () => {
    expect(
      fruitVegShare('Ingrediënten: groenten 80% (tomaat 77%, ui, prei), water, soepballen 4,8% (varkensvlees¹ 3%, rundvlees¹ 0,9%), suiker'),
    ).toBe(80);
  });

  it('takes a list of nothing but fruit or vegetables and additives as 90%', () => {
    expect(fruitVegShare('Tomaten, zuurteregelaar: citroenzuur.')).toBe(90);
  });

  it('claims nothing that is not stated', () => {
    // Plenty of vegetables, no percentages, and cheese and pasta besides.
    expect(fruitVegShare('Rode peper, wortel, EI, tomaten, aubergine, courgette, belegen kaas (LACTOSE), TARWEgriesmeel, zout.')).toBeNull();
    // Only the lentils say how much.
    expect(fruitVegShare('Ingrediënten: Tomaat*, ui, 21% rode linzen, paprika*, wortel, groentebouillonblokje (zout, groenten (ui))')).toBe(21);
    expect(fruitVegShare('Kruiden, zout, suiker')).toBeNull();
    expect(fruitVegShare('')).toBeNull();
  });

  it("doesn't count nuts, corn, potatoes or things made from vegetables", () => {
    expect(fruitVegShare('Ingrediënten: 49% PINDA, zonnebloemolie, 9% mais, 6% rijst, 5% tapiocazetmeel, aardappelzetmeel, maispoeder')).toBeNull();
    expect(fruitVegShare('60% aardappelen, zonnebloemolie, zout')).toBeNull();
    expect(fruitVegShare('olijfolie 100%')).toBeNull();
  });

  it("doesn't take 'ui' out of other words", () => {
    expect(fruitVegShare('kruiden 50%, fruitig aroma')).toBeNull();
  });
});
