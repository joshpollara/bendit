import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';
import { shortDate } from '../lib/dates';
import { formatCalories, kgToLb } from '../lib/units';
import type { Units } from '../types';
import { useChartColors } from '../lib/chartColors';

// Colors come from the app's CSS tokens so the charts follow the theme. The
// muted gray on the raw weigh-ins is deliberate — they read as background noise
// under the trend line, and mark type plus the legend carry the distinction,
// not color alone.

const tooltipBox = 'rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-md';

export interface WeightPoint {
  date: string;
  scale?: number; // the reading, when there was one
  trend?: number;
}

function WeightTooltip({
  active,
  payload,
  unit,
}: TooltipProps<number, string> & { unit: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as WeightPoint;
  return (
    <div className={tooltipBox}>
      <p className="font-medium text-ink">{shortDate(p.date)}</p>
      {p.trend != null && (
        <p className="text-ink-secondary">
          Trend {p.trend.toFixed(1)} {unit}
        </p>
      )}
      {p.scale != null && (
        <p className="text-ink-muted">
          Scale {p.scale.toFixed(1)} {unit}
        </p>
      )}
    </div>
  );
}

// Raw weigh-ins as dots under a trend line. The trend is the series being read;
// the dots show how much noise it is absorbing.
export function TrendChart({
  data,
  goalKg,
  units,
}: {
  data: WeightPoint[];
  goalKg: number;
  units: Units;
}) {
  // RAW and MUTED are the same token on purpose: the scale dots are meant to
  // sit back with the axis furniture, under the trend line.
  const { accent: TREND, grid: GRID, muted: MUTED } = useChartColors();
  const RAW = MUTED;
  const unit = units === 'imperial' ? 'lb' : 'kg';
  const toDisplay = (kg: number) => (units === 'imperial' ? kgToLb(kg) : kg);
  const goal = +toDisplay(goalKg).toFixed(1);

  const values = data.flatMap((d) => [d.scale, d.trend]).filter((v): v is number => v != null);
  const lo = Math.floor(Math.min(...values, goal) - 1);
  const hi = Math.ceil(Math.max(...values, goal) + 1);

  return (
    <>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
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
            content={(props: TooltipProps<number, string>) => (
              <WeightTooltip {...props} unit={unit} />
            )}
            cursor={{ stroke: MUTED, strokeDasharray: '3 3', strokeWidth: 1 }}
          />
          <ReferenceLine
            y={goal}
            stroke={MUTED}
            strokeDasharray="4 4"
            label={{
              value: `Goal ${goal}`,
              position: 'insideBottomRight',
              fontSize: 11,
              fill: MUTED,
            }}
          />
          <Scatter dataKey="scale" fill={RAW} shape="circle" isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="trend"
            stroke={TREND}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <Legend
        items={[
          { color: TREND, label: `Trend (${unit})`, kind: 'line' },
          { color: RAW, label: 'Scale reading', kind: 'dot' },
        ]}
      />
    </>
  );
}

function Legend({
  items,
}: {
  items: { color: string; label: string; kind: 'line' | 'dot' | 'bar' | 'dashed' }[];
}) {
  const swatch = {
    line: 'block h-0.5 w-4 rounded-full',
    dot: 'block h-2 w-2 rounded-full',
    bar: 'block h-2.5 w-2.5 rounded-sm',
    dashed: 'block h-0 w-4 border-t-2 border-dashed',
  } as const;

  return (
    <ul className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-ink-secondary">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={i.kind === 'dashed' ? { borderColor: i.color } : { background: i.color }}
            className={swatch[i.kind]}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export interface CaloriePoint {
  date: string;
  net: number | null; // null on days with nothing logged
  average: number | null; // weighted average of net calories
}

function CalorieTooltip({ active, payload, budget }: TooltipProps<number, string> & { budget: number }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as CaloriePoint;
  if (p.net == null) {
    return (
      <div className={tooltipBox}>
        <p className="font-medium text-ink">{shortDate(p.date)}</p>
        <p className="text-ink-muted">Nothing logged</p>
      </div>
    );
  }
  const diff = Math.round(p.net - budget);
  return (
    <div className={tooltipBox}>
      <p className="font-medium text-ink">{shortDate(p.date)}</p>
      <p className="text-ink-secondary">Net {formatCalories(p.net)} cal</p>
      <p className={diff > 0 ? 'text-over' : 'text-good'}>
        {diff > 0 ? `${formatCalories(diff)} over` : `${formatCalories(-diff)} under`} budget
      </p>
      {p.average != null && (
        <p className="text-ink-muted">Average {formatCalories(p.average)} cal</p>
      )}
    </div>
  );
}

// Daily net calories against the budget line, with the weighted average showing
// where intake actually sits once single days stop dominating.
export function CalorieChart({ data, budget }: { data: CaloriePoint[]; budget: number }) {
  const { accent: TREND, grid: GRID, muted: MUTED } = useChartColors();
  const RAW = MUTED;
  return (
    <>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
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
            tick={{ fontSize: 11, fill: MUTED }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            content={(props: TooltipProps<number, string>) => (
              <CalorieTooltip {...props} budget={budget} />
            )}
            cursor={{ fill: 'rgba(138,147,156,0.12)' }}
          />
          {/* Unlabeled: the line sits mid-plot, where any label lands on the
              bars. The caption names the budget instead. */}
          <ReferenceLine y={budget} stroke={MUTED} strokeDasharray="4 4" />
          <Bar dataKey="net" fill={RAW} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="average"
            stroke={TREND}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <Legend
        items={[
          { color: RAW, label: 'Net calories', kind: 'bar' },
          { color: TREND, label: 'Weighted average', kind: 'line' },
          { color: MUTED, label: `Budget ${formatCalories(budget)}`, kind: 'dashed' },
        ]}
      />
    </>
  );
}

// Average calories per meal — magnitude across four fixed categories, so one
// hue and horizontal bars, sorted by the meal order of the day.
export function MealChart({ data }: { data: { meal: string; average: number }[] }) {
  const { accent: TREND, muted: MUTED } = useChartColors();
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="meal"
          tick={{ fontSize: 12, fill: MUTED }}
          tickLine={false}
          axisLine={false}
          width={76}
        />
        <Bar
          dataKey="average"
          fill={TREND}
          radius={[0, 4, 4, 0]}
          barSize={16}
          isAnimationActive={false}
          label={{
            position: 'right',
            fontSize: 11,
            fill: MUTED,
            formatter: (v: number) => `${formatCalories(v)} cal`,
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
