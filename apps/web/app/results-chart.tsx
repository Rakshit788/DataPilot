"use client";

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";

export type ChartSpec = { type: "bar" | "line" | "pie" | "scatter" | "table"; xKey: string; yKey: string; title: string };
export type ResultColumn = { name: string; dataTypeId?: number };

const colors = ["#477957", "#83a96d", "#d5a75c", "#7399a0", "#b47a69", "#8c80aa"];

export default function ResultsChart({ rows, columns, spec }: { rows: Record<string, unknown>[]; columns: ResultColumn[]; spec?: ChartSpec | null }) {
  const names = new Set(columns.map((column) => column.name));
  if (!spec || spec.type === "table" || !names.has(spec.xKey) || !names.has(spec.yKey) || rows.length === 0) return null;
  const data = rows.map((row) => ({ ...row, [spec.yKey]: Number(row[spec.yKey]) })).filter((row) => Number.isFinite(row[spec.yKey]));
  if (data.length === 0) return null;
  const xAxis = <XAxis dataKey={spec.xKey} tick={{ fontSize: 10, fill: "#7b8981" }} tickLine={false} axisLine={{ stroke: "#e8ece8" }} />;
  const yAxis = <YAxis tick={{ fontSize: 10, fill: "#7b8981" }} tickLine={false} axisLine={false} />;
  return <section className="result-chart"><h4>{spec.title}</h4><div className="chart-frame"><ResponsiveContainer width="100%" height="100%">
    {spec.type === "bar" ? <BarChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: -12 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0ed" />{xAxis}{yAxis}<Tooltip /><Bar dataKey={spec.yKey} fill="#477957" radius={[4, 4, 0, 0]} /></BarChart> :
      spec.type === "line" ? <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: -12 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#edf0ed" />{xAxis}{yAxis}<Tooltip /><Line type="monotone" dataKey={spec.yKey} stroke="#477957" strokeWidth={2} dot={{ r: 2 }} /></LineChart> :
        spec.type === "pie" ? <PieChart><Tooltip /><Pie data={data} dataKey={spec.yKey} nameKey={spec.xKey} innerRadius={42} outerRadius={83} paddingAngle={2}>{data.map((_, index) => <Cell key={index} fill={colors[index % colors.length] ?? "#477957"} />)}</Pie></PieChart> :
          <ScatterChart margin={{ top: 10, right: 12, bottom: 4, left: -12 }}><CartesianGrid strokeDasharray="3 3" stroke="#edf0ed" />{xAxis}{yAxis}<Tooltip /><Scatter data={data} fill="#477957" /></ScatterChart>}
  </ResponsiveContainer></div></section>;
}
