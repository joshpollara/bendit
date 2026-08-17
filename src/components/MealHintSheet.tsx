import { useState } from 'react';
import { MAX_MEAL_HINT_LENGTH, normalizeMealHint } from '../lib/mealPhoto';
import { CameraIcon } from './Icons';
import Sheet from './Sheet';

// Asked before the shutter, not after.
//
// The model reads a plate well enough to say there is meat and rice on it, and
// nowhere near well enough to say whether that is veal or pork, couscous or
// bulgur, or that the pale sauce is crème fraîche rather than yoghurt. Someone
// who cooked the meal knows all of it in three words. Those three words are
// worth far more before the photograph is read than as a correction to a wrong
// answer afterwards — a correction fixes one item on one screen, a description
// changes what the model is looking for, and the portion, the preparation and
// the database match all follow from it.
//
// Optional, always. Photographing a meal has to stay a two-tap action for the
// times when nobody wants to type, so Skip is a first-class button and an empty
// box behaves exactly as this feature never existed.

const EXAMPLES = ['Chicken shawarma with rice', 'Porridge with milk', 'Cheese sandwich'];

export default function MealHintSheet({
  initial = '',
  onStart,
  onClose,
}: {
  /** What was typed last time, so a retake doesn't have to be typed again. */
  initial?: string;
  onStart: (hint: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const hint = normalizeMealHint(text);

  return (
    <Sheet onClose={onClose}>
      <h2 className="text-lg font-semibold">What are you eating?</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Optional, and it makes the photo much easier to read. Name the food — the photo is what
        decides the portion.
      </p>

      <input
        type="text"
        autoFocus
        value={text}
        maxLength={MAX_MEAL_HINT_LENGTH}
        placeholder="e.g. spaghetti bolognese"
        aria-label="What you are eating"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onStart(hint);
        }}
        className="mt-3 w-full rounded-xl border border-line bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-secondary hover:border-accent hover:text-accent"
          >
            {example}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onStart(hint)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 font-semibold text-white"
      >
        <CameraIcon className="h-5 w-5" />
        Take the photo
      </button>
      <button
        type="button"
        onClick={() => onStart(null)}
        className="mt-2 w-full py-2 text-sm font-medium text-ink-secondary"
      >
        Skip, just photograph it
      </button>
    </Sheet>
  );
}
