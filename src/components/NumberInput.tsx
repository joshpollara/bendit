import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { parseNumberDraft } from '../lib/numberDraft';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number | null;
  onCommit: (value: number) => void;
  allowZero?: boolean;
  /** Only hand the number over on blur or Enter, not while it is being typed. */
  commitOnBlur?: boolean;
};

/**
 * A number field that keeps its own text while it has focus. Binding an input
 * straight to a number turns an emptied field into 0 (or refuses the edit), so
 * the old value can't be cleared and retyped. Here the text is only a draft: a
 * valid number is committed, and anything else goes back to the last value
 * when the field loses focus.
 */
export default function NumberInput({
  value,
  onCommit,
  allowZero = false,
  commitOnBlur = false,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: Props) {
  const displayed = value == null ? '' : String(value);
  const [draft, setDraft] = useState(displayed);
  const [focused, setFocused] = useState(false);

  // Outside edits (a stepper, a unit switch) show up unless the person is typing.
  useEffect(() => {
    if (!focused) setDraft(displayed);
  }, [displayed, focused]);

  const commit = (text: string) => {
    const next = parseNumberDraft(text, { allowZero });
    if (next != null && next !== value) onCommit(next);
    return next;
  };

  return (
    <input
      {...props}
      type="number"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (!commitOnBlur) commit(event.target.value);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (commit(draft) == null) setDraft(displayed);
        setFocused(false);
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        onKeyDown?.(event);
      }}
    />
  );
}
