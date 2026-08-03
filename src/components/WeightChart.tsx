import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import { shortDate } from '../lib/dates';
import { kgToLb } from '../lib/units';
import type { Units, WeightEntry } from '../types';

// Colors mirror the validated theme tokens in index.css.
const ACCENT = '#2a70a0';
const GRID = '#e7e5e0';
const MUTED = '#8a939c';

interface Point {
  date: string;
  weight: number;
}

function ChartTooltip({ active, payload, unit }: TooltipProps<number, string> & { unit: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as Point;
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium text-ink">{shortDate(p.date)}</p>
      <p className="text-ink-secondary">
        {p.weight.toFixed(1)} {unit}
      </p>
    </div>
  );
}

export default function WeightChart({
  entries,
  goalKg,
  units,
}: {
  entries: WeightEntry[]; // ascending by date
  goalKg: number;
  units: Units;
}) {
  const toDisplay = (kg: number) => (units === 'imperial' ? kgToLb(kg) : kg);
  const unit = units === 'imperial' ? 'lb' : 'kg';

  const data: Point[] = entries.map((e) => ({
    date: e.date,
    weight: +toDisplay(e.weightKg).toFixed(1),
  }));
  const goal = +toDisplay(goalKg).toFixed(1);

  const values = [...data.map((d) => d.weight), goal];
  const lo = Math.floor(Math.min(...values) - 2);
  const hi = Math.ceil(Math.max(...values) + 2);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDate}
          tick={{ fontSize: 11, fill: MUTED }}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
        <YAxis
          domain={[lo, hi]}
          tick={{ fontSize: 11, fill: MUTED }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <Tooltip
          content={(props: TooltipProps<number, string>) => <ChartTooltip {...props} unit={unit} />}
          cursor={{ stroke: MUTED, strokeDasharray: '3 3', strokeWidth: 1 }}
        />
        <ReferenceLine
          y={goal}
          stroke={MUTED}
          strokeDasharray="4 4"
          label={{ value: `Goal ${goal}`, position: 'insideBottomRight', fontSize: 11, fill: MUTED }}
        />
        <Line
          type="monotone"
          dataKey="weight"
          stroke={ACCENT}
          strokeWidth={2}
          dot={{ r: 3, fill: ACCENT, strokeWidth: 0 }}
          activeDot={{ r: 5, fill: ACCENT, stroke: '#ffffff', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
