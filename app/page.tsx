"use client";

import React, { useMemo, useState, useEffect } from "react";
import jsPDF from "jspdf";
import "jspdf-autotable";

/**
 * Deal Underwriter — Pro version (single-file)
 * Includes:
 * - FIX: Levered NPV / Exit Price / Payoff rendering (no NaN chain)
 * - Separate Rent Growth vs Other Income Growth (fully wired in engine)
 * - Exports:
 *    - IC Tear Sheet PDF (tables)
 *    - Math Reference PDF (formulas + arrays)
 *    - CSV export (annual table + CFs)
 * - Deal Library:
 *    - Save/Load/Rename/Delete deals via localStorage
 *
 * Notes:
 * - UI styling kept consistent with your existing components (no redesign)
 * - Still no partner splits
 */

type Tone = "good" | "warn" | "bad" | "neutral";
type AssetClass = "Multifamily" | "Office" | "Industrial" | "Retail/Commercial" | "Single Family Home";
type TopTab = "Underwrite" | "Sensitivity" | "Exports" | "Deal Library";

type UnitRow = { id: string; name: string; units: string; rent: string };

type OpexMode = "Percent of Revenue" | "Line Items" | "Per Unit / Year" | "Hybrid";
type OpexRow = { id: string; name: string; annual: string };

type CapexMode = "PSF / Year" | "Per Unit / Year";
type RecoveryMode = "None" | "% of OpEx" | "Flat Annual";

type SensMetric = "Levered IRR" | "Levered NPV" | "CoC (Y1)" | "DSCR (Y1)" | "Exit Price";

const STORAGE_KEY = "du_deals_v1";

const clampNum = (v: any, fallback = 0) => {
  const n = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const fmt0 = (n: any) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: 0 });

const fmt2 = (n: any) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: any) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : (n * 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";

const usd0 = (n: any) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : "$" + fmt0(n);

function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0);
}

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function pmtMonthly(loanAmount: number, annualRate: number, amortYears: number) {
  const r = annualRate / 12;
  const n = amortYears * 12;
  if (loanAmount <= 0 || n <= 0) return 0;
  if (r === 0) return loanAmount / n;
  return (loanAmount * r) / (1 - Math.pow(1 + r, -n));
}

function remainingBalance(loanAmount: number, annualRate: number, amortYears: number, kPayments: number) {
  const r = annualRate / 12;
  const n = amortYears * 12;
  if (loanAmount <= 0 || n <= 0) return 0;
  const pmt = pmtMonthly(loanAmount, annualRate, amortYears);
  if (r === 0) return loanAmount * (1 - kPayments / n);
  return loanAmount * Math.pow(1 + r, kPayments) - pmt * ((Math.pow(1 + r, kPayments) - 1) / r);
}

function npv(rate: number, cashflows: number[]) {
  const r = clampNum(rate, NaN);
  if (!Number.isFinite(r)) return NaN;
  let total = 0;
  for (let t = 0; t < cashflows.length; t++) {
    const cf = clampNum(cashflows[t], NaN);
    if (!Number.isFinite(cf)) return NaN;
    total += cf / Math.pow(1 + r, t);
  }
  return total;
}

function irr(cashflows: number[]) {
  let hasNeg = false;
  let hasPos = false;
  for (const cf0 of cashflows) {
    const cf = clampNum(cf0, NaN);
    if (!Number.isFinite(cf)) return null;
    if (cf < 0) hasNeg = true;
    if (cf > 0) hasPos = true;
  }
  if (!hasNeg || !hasPos) return null;

  let lo = -0.9999;
  let hi = 5;
  let fLo = npv(lo, cashflows);
  let fHi = npv(hi, cashflows);

  let tries = 0;
  while (fLo * fHi > 0 && tries < 20) {
    hi *= 2;
    fHi = npv(hi, cashflows);
    tries++;
  }
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < 140; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, cashflows);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function uid() {
  return Math.random().toString(16).slice(2);
}

function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  const cls =
    tone === "good"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : tone === "bad"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-slate-200 bg-white text-slate-700";
  return <span className={cn("inline-flex items-center rounded-full border px-3 py-1 text-xs", cls)}>{children}</span>;
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs text-slate-700 backdrop-blur">
      {children}
    </span>
  );
}

function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-slate-900">{title}</div>
          {subtitle ? <div className="mt-0.5 text-xs text-slate-600">{subtitle}</div> : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  help,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  help?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {help ? <div className="text-[11px] text-slate-500">{help}</div> : null}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
          inputMode="decimal"
        />
        {suffix ? <div className="text-sm text-slate-600 whitespace-nowrap">{suffix}</div> : null}
      </div>
    </label>
  );
}

function MiniKPI({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_1px_0_rgba(15,23,42,0.04)]">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900">{value}</div>
      {sub ? <div className="mt-1 text-xs text-slate-600">{sub}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-slate-600">{label}</span>
      <span className="font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-2xl px-4 py-2 text-sm font-medium border transition",
        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white hover:bg-slate-100"
      )}
    >
      {label}
    </button>
  );
}

function buildRecommendation({
  dscr,
  coc,
  irrLevered,
}: {
  dscr: number | null;
  coc: number | null;
  irrLevered: number | null;
}) {
  const BENCH = { dscr: 1.25, coc: 0.08, irr: 0.12 };
  const notes: { tone: Tone; title: string; text: string }[] = [];

  if (dscr == null) notes.push({ tone: "bad", title: "DSCR missing", text: "Debt or NOI inputs are incomplete." });
  else if (dscr >= BENCH.dscr) notes.push({ tone: "good", title: "Healthy DSCR", text: `DSCR ${fmt2(dscr)} ≥ ~${fmt2(BENCH.dscr)}.` });
  else if (dscr >= 1.05) notes.push({ tone: "warn", title: "Tight DSCR", text: `DSCR ${fmt2(dscr)} leaves less cushion.` });
  else notes.push({ tone: "bad", title: "Weak DSCR", text: `DSCR ${fmt2(dscr)} may be hard to finance.` });

  if (coc == null) notes.push({ tone: "bad", title: "CoC missing", text: "Equity or cash flow inputs are incomplete." });
  else if (coc >= BENCH.coc) notes.push({ tone: "good", title: "Competitive cash yield", text: `CoC ${fmtPct(coc)}.` });
  else if (coc >= 0.04) notes.push({ tone: "warn", title: "Modest cash yield", text: `CoC ${fmtPct(coc)} (could still work with growth).` });
  else notes.push({ tone: "bad", title: "Low cash yield", text: `CoC ${fmtPct(coc)} is very low for the risk.` });

  if (irrLevered == null) notes.push({ tone: "bad", title: "IRR missing", text: "Cash flows don’t produce a valid IRR." });
  else if (irrLevered >= BENCH.irr) notes.push({ tone: "good", title: "Strong IRR", text: `IRR ${fmtPct(irrLevered)}.` });
  else if (irrLevered >= 0.08) notes.push({ tone: "warn", title: "OK IRR", text: `IRR ${fmtPct(irrLevered)} — depends on risk/market.` });
  else notes.push({ tone: "bad", title: "Weak IRR", text: `IRR ${fmtPct(irrLevered)} — likely overpaying or weak assumptions.` });

  const good = notes.filter((n) => n.tone === "good").length;
  const bad = notes.filter((n) => n.tone === "bad").length;

  let headline = "Borderline — needs diligence";
  let tone: Tone = "warn";
  if (bad >= 2) {
    headline = "Likely not worth it (as modeled)";
    tone = "bad";
  } else if (good >= 2 && bad === 0) {
    headline = "Likely worth pursuing";
    tone = "good";
  }
  return { headline, tone, notes, benchmarks: BENCH };
}

/**
 * Core model engine (final)
 * - Separate rent growth and other income growth
 * - Produces clean finite outputs (no NaN chains)
 */
function computeModel(args: {
  assetClass: AssetClass;
  squareFootage: number;
  purchasePrice: number;
  dueDiligenceCosts: number;
  closingCostPct: number;

  saleYear: number;

  rentGrowth: number;
  otherIncomeGrowth: number;
  vacancyRate: number;

  annualRevenue: number;
  otherIncomeAnnual: number;

  rentRollGPR: number;
  rentRollUnits: number;

  opexMode: OpexMode;
  opexPctOfRev: number;
  opexPerUnitYear: number;
  mgmtFeePct: number;
  reservesPerUnitYear: number;
  opexItemsYear1: number;
  expenseInflation: number; // OpEx growth

  recoveryMode: RecoveryMode;
  recoveryPctOfOpex: number;
  recoveryFlatAnnual: number;

  capexMode: CapexMode;
  capexPsfYear1: number;
  capexPerUnitYear1: number;
  capexGrowth: number;

  exitCapRate: number;
  costOfSalePct: number;

  ltv: number;
  interestRate: number;
  amortYears: number;

  discountRate: number;
}) {
  const {
    assetClass,
    squareFootage: SF,
    purchasePrice: PP,
    dueDiligenceCosts: DD,
    closingCostPct: closePct,
    saleYear: N,

    rentGrowth,
    otherIncomeGrowth,
    vacancyRate: vac,

    annualRevenue,
    otherIncomeAnnual,

    rentRollGPR,
    rentRollUnits,

    opexMode: opMode,
    opexPctOfRev: opPct,
    opexPerUnitYear: opPU,
    mgmtFeePct: mgmtPct,
    reservesPerUnitYear: resPU,
    opexItemsYear1,
    expenseInflation: gExp,

    recoveryMode: recMode,
    recoveryPctOfOpex: recPct,
    recoveryFlatAnnual: recFlat,

    capexMode: capMode,
    capexPsfYear1: capPsf,
    capexPerUnitYear1: capPU,
    capexGrowth: gCapex,

    exitCapRate: exitCap,
    costOfSalePct: saleCost,

    ltv: LTV,
    interestRate: r,
    amortYears: amort,

    discountRate: disc,
  } = args;
const gRev = rentGrowth;
const gOther = otherIncomeGrowth;

  const rentG = clampNum(rentGrowth, 0);
  const otherG = clampNum(otherIncomeGrowth, rentG);
  const vacSafe = Math.max(0, clampNum(vac, 0));
  const exitCapSafe = Math.max(1e-9, clampNum(exitCap, 0.065));
  const saleCostSafe = Math.max(0, clampNum(saleCost, 0));
  const discSafe = Math.max(0, clampNum(disc, 0.12));
  const expG = Math.max(0, clampNum(gExp, 0));

  // Revenue streams (separate)
  const baseRent1 = Math.max(0, assetClass === "Multifamily" ? rentRollGPR : annualRevenue);
  const baseOther1 = Math.max(0, otherIncomeAnnual);

  const loanProceeds = Math.max(0, PP) * Math.max(0, Math.min(1, clampNum(LTV, 0)));
  const debtPmtAnnual = pmtMonthly(loanProceeds, Math.max(0, r), Math.max(1, amort)) * 12;
let loanBal = loanProceeds;
let payoff = loanProceeds;

for (let t = 1; t <= N; t++) {
  const interest = loanBal * r;
  const principal = Math.max(0, debtPmtAnnual - interest);
  loanBal = Math.max(0, loanBal - principal);

  if (t === N) payoff = loanBal;
}

  const acquisitionCF = -(Math.max(0, PP) + Math.max(0, DD) + Math.max(0, PP) * Math.max(0, closePct));

  // Arrays include N+1 for exit NOI (NOI_{N+1})
  const rentRev: number[] = new Array(N + 2).fill(0);
  const otherRev: number[] = new Array(N + 2).fill(0);
  const revenue: number[] = new Array(N + 2).fill(0);
  const recoveries: number[] = new Array(N + 2).fill(0);
  const vacancyLoss: number[] = new Array(N + 2).fill(0);
  const egr: number[] = new Array(N + 2).fill(0);
  const opexAbs: number[] = new Array(N + 2).fill(0);
  const capexAbs: number[] = new Array(N + 2).fill(0);
  const noi: number[] = new Array(N + 2).fill(0);

  const unleveredCF: number[] = new Array(N + 1).fill(0);
  const leveredCF: number[] = new Array(N + 1).fill(0);

  const units = assetClass === "Multifamily" ? Math.max(0, rentRollUnits) : 1;

  for (let y = 1; y <= N + 1; y++) {
    rentRev[y] = baseRent1 * Math.pow(1 + rentG, y - 1);
    otherRev[y] = baseOther1 * Math.pow(1 + otherG, y - 1);
    revenue[y] = rentRev[y] + otherRev[y];

    // OpEx base
    let baseOpex = 0;
    if (opMode === "Percent of Revenue") {
      // Use EGI-ish proxy here (rev only). Vacancy applied below to (rev+recovery)
      baseOpex = Math.max(0, opPct) * revenue[y];
    } else {
      const lineItemsY = Math.max(0, opexItemsYear1) * Math.pow(1 + expG, y - 1);
      const perUnitY = (Math.max(0, opPU) * units) * Math.pow(1 + expG, y - 1);

      if (opMode === "Line Items") baseOpex = lineItemsY;
      if (opMode === "Per Unit / Year") baseOpex = perUnitY;
      if (opMode === "Hybrid") baseOpex = lineItemsY + perUnitY;
    }

    const mgmt = Math.max(0, mgmtPct) * revenue[y];
    const reserves = (Math.max(0, resPU) * units) * Math.pow(1 + expG, y - 1);
    opexAbs[y] = Math.max(0, baseOpex + mgmt + reserves);

    // Recoveries
    if (recMode === "None") recoveries[y] = 0;
    if (recMode === "% of OpEx") recoveries[y] = Math.max(0, recPct) * opexAbs[y];
    if (recMode === "Flat Annual") recoveries[y] = Math.max(0, recFlat) * Math.pow(1 + rentG, y - 1);

    // Vacancy applies to (revenue + recoveries)
    vacancyLoss[y] = -((revenue[y] + recoveries[y]) * vacSafe);
    egr[y] = revenue[y] + recoveries[y] + vacancyLoss[y];

    noi[y] = egr[y] - opexAbs[y];

    // CapEx
    if (capMode === "PSF / Year") capexAbs[y] = (Math.max(0, capPsf) * Math.max(0, SF)) * Math.pow(1 + Math.max(0, gCapex), y - 1);
    else capexAbs[y] = (Math.max(0, capPU) * units) * Math.pow(1 + Math.max(0, gCapex), y - 1);
  }

  // Unlevered CFs: t=0 acquisition; t=1..N operations; at t=N add sale proceeds based on NOI_{N+1}
  unleveredCF[0] = acquisitionCF;
  for (let y = 1; y <= N; y++) unleveredCF[y] = noi[y] - capexAbs[y];

  const salePrice = noi[N + 1] / exitCapSafe;
  const saleCosts = salePrice * saleCostSafe;
  const saleNetBeforeDebt = salePrice - saleCosts;
  unleveredCF[N] += saleNetBeforeDebt;

  // Levered CFs
  leveredCF[0] = unleveredCF[0] + loanProceeds;

  const payoffAtExit = Math.max(0, remainingBalance(loanProceeds, Math.max(0, r), Math.max(1, amort), N));
  for (let y = 1; y <= N; y++) {
    const debtSvc = debtPmtAnnual;
    leveredCF[y] = (noi[y] - capexAbs[y]) - debtSvc;
   if (y === N) leveredCF[y] = ((noi[y] - capexAbs[y]) - debtSvc) + (saleNetBeforeDebt - payoff);
  }

  const uIRR = irr(unleveredCF);
  const lIRR = irr(leveredCF);

  const uNPV = npv(discSafe, unleveredCF);
  const lNPV = npv(discSafe, leveredCF);

  const noi1 = noi[1];
  const capRate = PP > 0 ? noi1 / PP : null;
  const dscr = debtPmtAnnual > 0 ? noi1 / debtPmtAnnual : null;

  const equityOut = -(leveredCF[0]);
  const coc = equityOut > 0 ? leveredCF[1] / equityOut : null;

  const rec = buildRecommendation({ dscr, coc, irrLevered: lIRR });

  return {
    N,
    capRate,
    dscr,
    coc,
    equityOut,

    rentRev,
    otherRev,
    revenue,
    recoveries,
    vacancyLoss,
    egr,
    opexAbs,
    noi,
    capexAbs,

    salePrice,
    saleCosts,
    saleNetBeforeDebt,

    loanProceeds,
    debtPmtAnnual,
    payoff,

    unleveredCF,
    leveredCF,

    uIRR,
    lIRR,
    uNPV,
    lNPV,
    noi1,

    recommendation: rec,
  };
}

function metricValue(model: ReturnType<typeof computeModel>, metric: SensMetric) {
  switch (metric) {
    case "Levered IRR":
      return model.lIRR;
    case "Levered NPV":
      return model.lNPV;
    case "CoC (Y1)":
      return model.coc;
    case "DSCR (Y1)":
      return model.dscr;
    case "Exit Price":
      return model.salePrice;
  }
}

function metricFormat(metric: SensMetric, v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (metric === "Levered IRR" || metric === "CoC (Y1)") return fmtPct(v);
  if (metric === "DSCR (Y1)") return fmt2(v);
  return usd0(v);
}

/** Download helper */
function downloadTextFile(filename: string, text: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** CSV export (annual table + cash flows) */
function exportModelCsv(model: ReturnType<typeof computeModel>) {
  const N = model.N;
  const rows: string[][] = [];
  rows.push([
    "Year",
    "RentRevenue",
    "OtherIncome",
    "TotalRevenue",
    "Recoveries",
    "VacancyLoss",
    "EGI",
    "OpEx",
    "NOI",
    "CapEx",
    "UnleveredCF",
    "LeveredCF",
  ]);

  for (let y = 0; y <= N; y++) {
    if (y === 0) {
      rows.push([
        "0",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        String(Math.round(model.unleveredCF[0])),
        String(Math.round(model.leveredCF[0])),
      ]);
    } else {
      rows.push([
        String(y),
        String(Math.round(model.rentRev[y])),
        String(Math.round(model.otherRev[y])),
        String(Math.round(model.revenue[y])),
        String(Math.round(model.recoveries[y])),
        String(Math.round(model.vacancyLoss[y])),
        String(Math.round(model.egr[y])),
        String(Math.round(model.opexAbs[y])),
        String(Math.round(model.noi[y])),
        String(Math.round(model.capexAbs[y])),
        String(Math.round(model.unleveredCF[y])),
        String(Math.round(model.leveredCF[y])),
      ]);
    }
  }

  // Add exit-year NOI_{N+1} for reference
  rows.push([]);
  rows.push(["ExitNOI_(N+1)", String(Math.round(model.noi[N + 1]))]);
  rows.push(["ExitPrice", String(Math.round(model.salePrice))]);
  rows.push(["SaleCosts", String(Math.round(model.saleCosts))]);
  rows.push(["Payoff", String(Math.round(model.payoff))]);
  rows.push(["NetSaleBeforeDebt", String(Math.round(model.saleNetBeforeDebt))]);

  const csv = rows
    .map((r) => r.map((cell) => (cell.includes(",") ? `"${cell.replaceAll('"', '""')}"` : cell)).join(","))
    .join("\n");

  downloadTextFile("deal-underwriter-export.csv", csv, "text/csv;charset=utf-8");
}

/** PDF: Math reference */
function exportMathPdf(model: ReturnType<typeof computeModel>, baseArgs: any) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const W = 612;
  const left = 48;
  let y = 56;

  const line = (s: string, size = 10, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(s, W - left * 2);
    doc.text(wrapped, left, y);
    y += wrapped.length * (size + 2);
    if (y > 740) {
      doc.addPage();
      y = 56;
    }
  };

  line("Deal Underwriter — Math Reference", 16, true);
  line(`Generated: ${new Date().toLocaleString()}`, 9, false);
  y += 8;

  line("Key Formulas", 12, true);
  line("1) Rent_t = Rent_1 × (1 + g_rent)^(t-1)");
  line("2) Other_t = Other_1 × (1 + g_other)^(t-1)");
  line("3) Revenue_t = Rent_t + Other_t");
  line("4) VacancyLoss_t = - (Revenue_t + Recoveries_t) × VacancyRate");
  line("5) EGI_t = Revenue_t + Recoveries_t + VacancyLoss_t");
  line("6) NOI_t = EGI_t − OpEx_t");
  line("7) UnleveredCF_0 = −(PurchasePrice + DD + ClosingCosts)");
  line("8) UnleveredCF_t = NOI_t − CapEx_t (t=1..N)");
  line("9) ExitPrice = NOI_(N+1) / ExitCapRate");
  line("10) SaleNet = ExitPrice − (ExitPrice × CostOfSalePct)");
  line("11) LeveredCF_0 = UnleveredCF_0 + LoanProceeds");
  line("12) DebtService = PMT(Loan, Rate, Amort) × 12");
  line("13) Payoff = RemainingBalance(Loan, Rate, Amort, N×12)");
  line("14) LeveredCF_N includes SaleNet − Payoff");
  line("15) NPV(rate) = Σ CF_t / (1+rate)^t");
  y += 6;

  line("Assumptions (snapshot)", 12, true);
  line(
    `PP ${usd0(baseArgs.purchasePrice)} | Hold ${baseArgs.saleYear}y | g_rent ${fmtPct(baseArgs.rentGrowth)} | g_other ${fmtPct(
      baseArgs.otherIncomeGrowth
    )} | Vac ${fmtPct(baseArgs.vacancyRate)} | ExitCap ${fmtPct(baseArgs.exitCapRate)}`,
    9
  );
  line(
    `LTV ${fmtPct(baseArgs.ltv)} | Rate ${fmtPct(baseArgs.interestRate)} | Amort ${baseArgs.amortYears}y | Disc ${fmtPct(
      baseArgs.discountRate
    )} | SaleCost ${fmtPct(baseArgs.costOfSalePct)}`,
    9
  );

  y += 6;
  line("Outputs", 12, true);
  line(`Levered IRR: ${fmtPct(model.lIRR)}   Levered NPV: ${usd0(model.lNPV)}   Exit Price: ${usd0(model.salePrice)}   Payoff: ${usd0(model.payoff)}`, 10, true);
  line(`Unlevered IRR: ${fmtPct(model.uIRR)}   Unlevered NPV: ${usd0(model.uNPV)}   DSCR(Y1): ${fmt2(model.dscr)}   CoC(Y1): ${fmtPct(model.coc)}`);

  y += 6;
  line("Cash Flows", 12, true);
  line(`Unlevered CF: [${model.unleveredCF.map((x) => Math.round(x)).join(", ")}]`, 8);
  line(`Levered CF:   [${model.leveredCF.map((x) => Math.round(x)).join(", ")}]`, 8);

  doc.save("deal-underwriter-math.pdf");
}

/** PDF: IC Tear Sheet (tables) */
function exportIcTearSheetPdf(model: ReturnType<typeof computeModel>, baseArgs: any) {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Deal Underwriter — IC Tear Sheet", 48, 52);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 48, 68);

  // Assumptions table
  autoTable(doc, {
    startY: 86,
    theme: "grid",
    head: [["Category", "Assumption", "Value"]],
    body: [
      ["Acquisition", "Purchase Price", usd0(baseArgs.purchasePrice)],
      ["Acquisition", "Due Diligence", usd0(baseArgs.dueDiligenceCosts)],
      ["Acquisition", "Closing Cost %", fmtPct(baseArgs.closingCostPct)],
      ["Timing", "Hold Period (Years)", String(baseArgs.saleYear)],
      ["Revenue", "Rent Growth", fmtPct(baseArgs.rentGrowth)],
      ["Revenue", "Other Income Growth", fmtPct(baseArgs.otherIncomeGrowth)],
      ["Revenue", "Vacancy / Credit Loss", fmtPct(baseArgs.vacancyRate)],
      ["Exit", "Exit Cap Rate", fmtPct(baseArgs.exitCapRate)],
      ["Exit", "Cost of Sale %", fmtPct(baseArgs.costOfSalePct)],
      ["Debt", "LTV", fmtPct(baseArgs.ltv)],
      ["Debt", "Interest Rate", fmtPct(baseArgs.interestRate)],
      ["Debt", "Amort (Years)", String(baseArgs.amortYears)],
      ["Returns", "Discount Rate (NPV)", fmtPct(baseArgs.discountRate)],
    ],
    styles: { font: "helvetica", fontSize: 9, cellPadding: 6 },
    headStyles: { fontStyle: "bold" },
  });

  // Returns table
  const y1 = (doc as any).lastAutoTable.finalY + 14;
  autoTable(doc, {
    startY: y1,
    theme: "grid",
    head: [["Return", "Value"]],
    body: [
      ["Go-in Cap Rate", fmtPct(model.capRate)],
      ["DSCR (Y1)", fmt2(model.dscr)],
      ["Cash-on-Cash (Y1)", fmtPct(model.coc)],
      ["Levered IRR", fmtPct(model.lIRR)],
      ["Levered NPV", usd0(model.lNPV)],
      ["Exit Price", usd0(model.salePrice)],
      ["Payoff", usd0(model.payoff)],
    ],
    styles: { font: "helvetica", fontSize: 9, cellPadding: 6 },
    headStyles: { fontStyle: "bold" },
  });

  // Annual summary (Years 1..min(N,10))
  const y2 = (doc as any).lastAutoTable.finalY + 14;
  const showYears = Math.min(model.N, 10);
  const annualRows = Array.from({ length: showYears }, (_, i) => {
    const y = i + 1;
    return [
      String(y),
      usd0(model.revenue[y]),
      usd0(model.opexAbs[y]),
      usd0(model.noi[y]),
      usd0(model.capexAbs[y]),
      usd0(model.unleveredCF[y]),
      usd0(model.leveredCF[y]),
    ];
  });

  autoTable(doc, {
    startY: y2,
    theme: "grid",
    head: [["Year", "Revenue", "OpEx", "NOI", "CapEx", "Unlev CF", "Lev CF"]],
    body: annualRows,
    styles: { font: "helvetica", fontSize: 9, cellPadding: 6 },
    headStyles: { fontStyle: "bold" },
  });

  doc.save("deal-underwriter-ic-tear-sheet.pdf");
}

/** Deal library types */
type DealSnapshot = {
  id: string;
  name: string;
  createdAt: number;
  assetClass: AssetClass;

  // inputs we need to restore
  squareFootage: string;
  purchasePrice: string;
  dueDiligenceCosts: string;
  closingCostPct: string;
  saleYear: string;
  rentGrowth: string;
  otherIncomeGrowth: string;
  opexGrowth: string;
  vacancyRate: string;
  annualRevenue: string;
  otherIncomeAnnual: string;
  unitTypes: UnitRow[];
  opexMode: OpexMode;
  opexPctOfRev: string;
  opexPerUnitYear: string;
  mgmtFeePct: string;
  reservesPerUnitYear: string;
  opexItems: OpexRow[];
  expenseInflation: string;
  recoveryMode: RecoveryMode;
  recoveryPctOfOpex: string;
  recoveryFlatAnnual: string;
  capexMode: CapexMode;
  capexPsfYear1: string;
  capexPerUnitYear1: string;
  capexGrowth: string;
  exitCapRate: string;
  costOfSalePct: string;
  ltv: string;
  interestRate: string;
  amortYears: string;
  discountRate: string;
};

function safeReadDeals(): DealSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DealSnapshot[];
  } catch {
    return [];
  }
}

function safeWriteDeals(deals: DealSnapshot[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deals));
}

export default function Page() {
  const [activeTab, setActiveTab] = useState<TopTab>("Underwrite");
  const [assetClass, setAssetClass] = useState<AssetClass>("Multifamily");

  // Core inputs
  const [squareFootage, setSquareFootage] = useState("329831");
  const [purchasePrice, setPurchasePrice] = useState("113000000");
  const [dueDiligenceCosts, setDueDiligenceCosts] = useState("225000");
  const [closingCostPct, setClosingCostPct] = useState("0.00");

  const [saleYear, setSaleYear] = useState("7");
  const [rentGrowth, setRentGrowth] = useState("0.03");
  const [otherIncomeGrowth, setOtherIncomeGrowth] = useState("0.03");
  const [opexGrowth, setOpexGrowth] = useState("0.00");

  const [vacancyRate, setVacancyRate] = useState("0.025");

  const [annualRevenue, setAnnualRevenue] = useState("7000000");
  const [otherIncomeAnnual, setOtherIncomeAnnual] = useState("0");

  // Multifamily rent roll
  const [unitTypes, setUnitTypes] = useState<UnitRow[]>([
    { id: "a", name: "1x1", units: "12", rent: "2400" },
    { id: "b", name: "2x2", units: "8", rent: "3100" },
  ]);

  // OpEx
  const [opexMode, setOpexMode] = useState<OpexMode>("Percent of Revenue");
  const [opexPctOfRev, setOpexPctOfRev] = useState("0.30");
  const [opexPerUnitYear, setOpexPerUnitYear] = useState("6500");
  const [mgmtFeePct, setMgmtFeePct] = useState("0.00");
  const [reservesPerUnitYear, setReservesPerUnitYear] = useState("0");
  const [opexItems, setOpexItems] = useState<OpexRow[]>([
    { id: uid(), name: "Property Taxes", annual: "0" },
    { id: uid(), name: "Insurance", annual: "0" },
    { id: uid(), name: "Repairs & Maintenance", annual: "0" },
  ]);
  const [expenseInflation, setExpenseInflation] = useState("0.03"); // legacy display only

  // Recoveries
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>("None");
  const [recoveryPctOfOpex, setRecoveryPctOfOpex] = useState("1.00");
  const [recoveryFlatAnnual, setRecoveryFlatAnnual] = useState("0");

  // CapEx
  const [capexMode, setCapexMode] = useState<CapexMode>("PSF / Year");
  const [capexPsfYear1, setCapexPsfYear1] = useState("0.30");
  const [capexPerUnitYear1, setCapexPerUnitYear1] = useState("350");
  const [capexGrowth, setCapexGrowth] = useState("0.03");

  // Exit
  const [exitCapRate, setExitCapRate] = useState("0.065");
  const [costOfSalePct, setCostOfSalePct] = useState("0.004");

  // Debt
  const [ltv, setLtv] = useState("0.55");
  const [interestRate, setInterestRate] = useState("0.065");
  const [amortYears, setAmortYears] = useState("30");

  // NPV
  const [discountRate, setDiscountRate] = useState("0.12");

  // Sensitivity controls
  const [sensMetric, setSensMetric] = useState<SensMetric>("Levered IRR");
  // Tornado controls
  const [tornadoMetric, setTornadoMetric] = useState<SensMetric>("Levered IRR");

  // Deal library state
  const [savedDeals, setSavedDeals] = useState<DealSnapshot[]>([]);
  const [dealName, setDealName] = useState("My Deal");

  useEffect(() => {
    // load deals on mount
    const deals = safeReadDeals();
    setSavedDeals(deals);
  }, []);

  // Derived rent roll totals
  const rentRoll = useMemo(() => {
    const rows = unitTypes
      .map((r) => ({
        ...r,
        unitsN: Math.max(0, Math.floor(clampNum(r.units))),
        rentN: Math.max(0, clampNum(r.rent)),
      }))
      .filter((r) => r.unitsN > 0 && r.rentN >= 0);

    const totalUnits = sum(rows.map((r) => r.unitsN));
    const gpr = sum(rows.map((r) => r.unitsN * r.rentN * 12));
    return { rows, totalUnits, gpr };
  }, [unitTypes]);

  const opexItemsYear1 = useMemo(
    () => sum(opexItems.map((x) => Math.max(0, clampNum(x.annual)))),
    [opexItems]
  );

  const baseArgs = useMemo(() => {
    const N = Math.max(1, Math.floor(clampNum(saleYear, 7)));
    return {
      assetClass,
      squareFootage: Math.max(0, clampNum(squareFootage)),
      purchasePrice: Math.max(0, clampNum(purchasePrice)),
      dueDiligenceCosts: Math.max(0, clampNum(dueDiligenceCosts)),
      closingCostPct: Math.max(0, clampNum(closingCostPct)),
      saleYear: N,

      // ✅ fully wired separate growth rates
      rentGrowth: clampNum(rentGrowth),
      otherIncomeGrowth: clampNum(otherIncomeGrowth),

      vacancyRate: clampNum(vacancyRate),
      annualRevenue: Math.max(0, clampNum(annualRevenue)),
      otherIncomeAnnual: Math.max(0, clampNum(otherIncomeAnnual)),
      rentRollGPR: rentRoll.gpr,
      rentRollUnits: rentRoll.totalUnits,

      opexMode,
      opexPctOfRev: Math.max(0, clampNum(opexPctOfRev)),
      opexPerUnitYear: Math.max(0, clampNum(opexPerUnitYear)),
      mgmtFeePct: Math.max(0, clampNum(mgmtFeePct)),
      reservesPerUnitYear: Math.max(0, clampNum(reservesPerUnitYear)),
      opexItemsYear1,

      // ✅ your OpEx Growth control drives the engine
      expenseInflation: clampNum(opexGrowth),

      recoveryMode,
      recoveryPctOfOpex: Math.max(0, clampNum(recoveryPctOfOpex)),
      recoveryFlatAnnual: Math.max(0, clampNum(recoveryFlatAnnual)),

      capexMode,
      capexPsfYear1: Math.max(0, clampNum(capexPsfYear1)),
      capexPerUnitYear1: Math.max(0, clampNum(capexPerUnitYear1)),
      capexGrowth: clampNum(capexGrowth),

      exitCapRate: Math.max(1e-9, clampNum(exitCapRate, 0.065)),
      costOfSalePct: Math.max(0, clampNum(costOfSalePct)),

     ltv: Math.max(0, clampNum(ltv) > 1 ? clampNum(ltv) / 100 : clampNum(ltv)),
interestRate: Math.max(0, clampNum(interestRate) > 1 ? clampNum(interestRate) / 100 : clampNum(interestRate)),
      amortYears: Math.max(1, Math.floor(clampNum(amortYears, 30))),

      discountRate: Math.max(0, clampNum(discountRate)),
    };
  }, [
    assetClass,
    squareFootage,
    purchasePrice,
    dueDiligenceCosts,
    closingCostPct,
    saleYear,
    rentGrowth,
    otherIncomeGrowth,
    vacancyRate,
    annualRevenue,
    otherIncomeAnnual,
    rentRoll.gpr,
    rentRoll.totalUnits,
    opexMode,
    opexPctOfRev,
    opexPerUnitYear,
    mgmtFeePct,
    reservesPerUnitYear,
    opexItemsYear1,
    opexGrowth,
    recoveryMode,
    recoveryPctOfOpex,
    recoveryFlatAnnual,
    capexMode,
    capexPsfYear1,
    capexPerUnitYear1,
    capexGrowth,
    exitCapRate,
    costOfSalePct,
    ltv,
    interestRate,
    amortYears,
    discountRate,
  ]);

  const model = useMemo(() => computeModel(baseArgs), [baseArgs]);

  function simulate(overrides: Partial<typeof baseArgs>) {
    return computeModel({ ...baseArgs, ...overrides } as any);
  }

  // CRUD helpers
  function updateUnitRow(id: string, patch: Partial<UnitRow>) {
    setUnitTypes((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addUnitRow() {
    setUnitTypes((prev) => [...prev, { id: uid(), name: "New", units: "0", rent: "0" }]);
  }
  function removeUnitRow(id: string) {
    setUnitTypes((prev) => prev.filter((r) => r.id !== id));
  }

  function updateOpexRow(id: string, patch: Partial<OpexRow>) {
    setOpexItems((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addOpexRow() {
    setOpexItems((prev) => [...prev, { id: uid(), name: "Custom Expense", annual: "0" }]);
  }
  function removeOpexRow(id: string) {
    setOpexItems((prev) => prev.filter((r) => r.id !== id));
  }

  // Deal library actions
  function snapshotCurrentDeal(): DealSnapshot {
    return {
      id: uid(),
      name: dealName.trim() ? dealName.trim() : "Untitled Deal",
      createdAt: Date.now(),
      assetClass,

      squareFootage,
      purchasePrice,
      dueDiligenceCosts,
      closingCostPct,
      saleYear,
      rentGrowth,
      otherIncomeGrowth,
      opexGrowth,
      vacancyRate,
      annualRevenue,
      otherIncomeAnnual,

      unitTypes,
      opexMode,
      opexPctOfRev,
      opexPerUnitYear,
      mgmtFeePct,
      reservesPerUnitYear,
      opexItems,
      expenseInflation,

      recoveryMode,
      recoveryPctOfOpex,
      recoveryFlatAnnual,

      capexMode,
      capexPsfYear1,
      capexPerUnitYear1,
      capexGrowth,

      exitCapRate,
      costOfSalePct,

      ltv,
      interestRate,
      amortYears,

      discountRate,
    };
  }

  function saveDeal() {
    const next = [snapshotCurrentDeal(), ...savedDeals].slice(0, 50); // cap to 50
    setSavedDeals(next);
    safeWriteDeals(next);
  }

  function loadDeal(d: DealSnapshot) {
    setAssetClass(d.assetClass);
    setDealName(d.name);

    setSquareFootage(d.squareFootage);
    setPurchasePrice(d.purchasePrice);
    setDueDiligenceCosts(d.dueDiligenceCosts);
    setClosingCostPct(d.closingCostPct);
    setSaleYear(d.saleYear);

    setRentGrowth(d.rentGrowth);
    setOtherIncomeGrowth(d.otherIncomeGrowth);
    setOpexGrowth(d.opexGrowth);
    setVacancyRate(d.vacancyRate);

    setAnnualRevenue(d.annualRevenue);
    setOtherIncomeAnnual(d.otherIncomeAnnual);

    setUnitTypes(d.unitTypes);

    setOpexMode(d.opexMode);
    setOpexPctOfRev(d.opexPctOfRev);
    setOpexPerUnitYear(d.opexPerUnitYear);
    setMgmtFeePct(d.mgmtFeePct);
    setReservesPerUnitYear(d.reservesPerUnitYear);
    setOpexItems(d.opexItems);
    setExpenseInflation(d.expenseInflation);

    setRecoveryMode(d.recoveryMode);
    setRecoveryPctOfOpex(d.recoveryPctOfOpex);
    setRecoveryFlatAnnual(d.recoveryFlatAnnual);

    setCapexMode(d.capexMode);
    setCapexPsfYear1(d.capexPsfYear1);
    setCapexPerUnitYear1(d.capexPerUnitYear1);
    setCapexGrowth(d.capexGrowth);

    setExitCapRate(d.exitCapRate);
    setCostOfSalePct(d.costOfSalePct);

    setLtv(d.ltv);
    setInterestRate(d.interestRate);
    setAmortYears(d.amortYears);

    setDiscountRate(d.discountRate);

    setActiveTab("Underwrite");
  }

  function deleteDeal(id: string) {
    const next = savedDeals.filter((x) => x.id !== id);
    setSavedDeals(next);
    safeWriteDeals(next);
  }

  function renameDeal(id: string, name: string) {
    const next = savedDeals.map((x) => (x.id === id ? { ...x, name: name.trim() || x.name } : x));
    setSavedDeals(next);
    safeWriteDeals(next);
  }

  // Top tabs
  const topTabs: AssetClass[] = ["Multifamily", "Office", "Industrial", "Retail/Commercial", "Single Family Home"];
  const appTabs: TopTab[] = ["Underwrite", "Sensitivity", "Exports", "Deal Library"];

  // Sensitivity: Purchase Price × Exit Cap Rate
  const sensitivity = useMemo(() => {
    const basePP = baseArgs.purchasePrice;
    const baseExitCap = baseArgs.exitCapRate;

    const ppMultipliers = [-0.1, -0.05, 0, 0.05, 0.1]; // ±10%
    const exitCapDeltas = [-0.01, -0.005, 0, 0.005, 0.01]; // ±100 bps

    const ppVals = ppMultipliers.map((m) => basePP * (1 + m));
    const capVals = exitCapDeltas.map((d) => Math.max(0.0001, baseExitCap + d));

    const grid = capVals.map((cap) =>
      ppVals.map((pp) => {
        const m = simulate({ purchasePrice: pp, exitCapRate: cap });
        return metricValue(m, sensMetric);
      })
    );

    return { ppMultipliers, exitCapDeltas, ppVals, capVals, grid };
  }, [baseArgs.purchasePrice, baseArgs.exitCapRate, sensMetric]);

  // Tornado chart (impact on chosen metric)
  const tornado = useMemo(() => {
    const baseV = metricValue(model, tornadoMetric);

    const scenarios: Array<{
      name: string;
      low: Partial<typeof baseArgs>;
      high: Partial<typeof baseArgs>;
    }> = [
      { name: "Purchase Price", low: { purchasePrice: baseArgs.purchasePrice * 0.95 }, high: { purchasePrice: baseArgs.purchasePrice * 1.05 } },
      { name: "Exit Cap Rate", low: { exitCapRate: Math.max(0.0001, baseArgs.exitCapRate - 0.005) }, high: { exitCapRate: baseArgs.exitCapRate + 0.005 } },
      { name: "Rent Growth", low: { rentGrowth: baseArgs.rentGrowth - 0.01 }, high: { rentGrowth: baseArgs.rentGrowth + 0.01 } },
      { name: "Other Income Growth", low: { otherIncomeGrowth: baseArgs.otherIncomeGrowth - 0.01 }, high: { otherIncomeGrowth: baseArgs.otherIncomeGrowth + 0.01 } },
      { name: "Vacancy Rate", low: { vacancyRate: Math.max(0, baseArgs.vacancyRate - 0.01) }, high: { vacancyRate: baseArgs.vacancyRate + 0.01 } },
      { name: "Interest Rate", low: { interestRate: Math.max(0, baseArgs.interestRate - 0.01) }, high: { interestRate: baseArgs.interestRate + 0.01 } },
      { name: "OpEx (Pct of Rev)", low: { opexPctOfRev: Math.max(0, baseArgs.opexPctOfRev - 0.03) }, high: { opexPctOfRev: baseArgs.opexPctOfRev + 0.03 } },
    ];

    const rows = scenarios.map((s) => {
      const lowM = simulate(s.low);
      const highM = simulate(s.high);
      const lowV = metricValue(lowM, tornadoMetric);
      const highV = metricValue(highM, tornadoMetric);

      const dLow = baseV != null && lowV != null ? lowV - baseV : null;
      const dHigh = baseV != null && highV != null ? highV - baseV : null;

      const swing = dLow == null || dHigh == null ? 0 : Math.max(Math.abs(dLow), Math.abs(dHigh));
      return { name: s.name, lowV, highV, dLow, dHigh, swing };
    });

    rows.sort((a, b) => b.swing - a.swing);
    const maxSwing = Math.max(0.000001, ...rows.map((r) => r.swing || 0));
    return { baseV, rows, maxSwing };
  }, [model, tornadoMetric, baseArgs]);

  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_circle_at_20%_-10%,rgba(59,130,246,0.12),transparent_55%),radial-gradient(900px_circle_at_100%_0%,rgba(16,185,129,0.10),transparent_45%),linear-gradient(to_bottom,#f8fafc,#ffffff)] text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-slate-900 text-white grid place-items-center font-semibold shadow-sm">
              DU
            </div>
            <div>
              <div className="text-lg font-semibold leading-tight">Deal Underwriter</div>
              <div className="text-xs text-slate-600">
                Excel-style underwriting • Sensitivity + Tornado • Exports + Deal Library
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Pill>No splits</Pill>
            <Pill>Exit = NOIₙ₊₁ / Cap</Pill>
            <Pill>Debt + Payoff</Pill>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-6 pb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {appTabs.map((t) => (
              <TabButton key={t} active={activeTab === t} label={t} onClick={() => setActiveTab(t)} />
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {topTabs.map((t) => (
              <TabButton
                key={t}
                active={assetClass === t}
                label={t}
                onClick={() => setAssetClass(t)}
              />
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {/* Global KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <MiniKPI label="NOI (Y1)" value={usd0(model.noi1)} sub={`Go-in cap ${fmtPct(model.capRate)}`} />
          <MiniKPI label="DSCR (Y1)" value={fmt2(model.dscr)} sub={`Debt svc ${usd0(model.debtPmtAnnual)}`} />
          <MiniKPI label="Cash-on-Cash (Y1)" value={fmtPct(model.coc)} sub={`Equity ${usd0(model.equityOut)}`} />
          <MiniKPI label="Levered IRR" value={fmtPct(model.lIRR)} sub={`Levered NPV ${usd0(model.lNPV)}`} />
          <MiniKPI label="Exit Price" value={usd0(model.salePrice)} sub={`Payoff ${usd0(model.payoff)}`} />
        </div>

        {/* Underwrite */}
        {activeTab === "Underwrite" ? (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card title="Property & timing" subtitle="Core underwriting assumptions.">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Square Footage" value={squareFootage} onChange={setSquareFootage} help="Used for PSF CapEx" />
                  <Field label="Purchase Price" value={purchasePrice} onChange={setPurchasePrice} suffix="$" />
                  <Field label="Due Diligence Costs" value={dueDiligenceCosts} onChange={setDueDiligenceCosts} suffix="$" />
                  <Field label="Closing Costs" value={closingCostPct} onChange={setClosingCostPct} help="0.02 = 2%" />
                  <Field label="Sale Year (Hold)" value={saleYear} onChange={setSaleYear} help="e.g. 7" />
                  <Field label="Rent Growth" value={rentGrowth} onChange={setRentGrowth} help="0.03 = 3%" />
                  <Field label="Other Income Growth" value={otherIncomeGrowth} onChange={setOtherIncomeGrowth} help="0.02 = 2%" />
                  <Field label="OpEx Growth" value={opexGrowth} onChange={setOpexGrowth} help="Used in model" />
                  <Field label="Vacancy / Credit Loss" value={vacancyRate} onChange={setVacancyRate} help="Applied to (Rev + Recoveries)" />
                  <Field label="Other Income (Annual)" value={otherIncomeAnnual} onChange={setOtherIncomeAnnual} suffix="$" help="Grows by Other Income Growth" />
                </div>
              </Card>

              {assetClass === "Multifamily" ? (
                <Card
                  title="Rent roll (by unit type)"
                  subtitle="Year-1 rent derives from rent roll, then grows annually."
                  right={
                    <button
                      onClick={addUnitRow}
                      className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-200 bg-white hover:bg-slate-100"
                    >
                      + Add unit type
                    </button>
                  }
                >
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-600">
                          <th className="py-2 pr-3">Unit Type</th>
                          <th className="py-2 pr-3"># Units</th>
                          <th className="py-2 pr-3">Monthly Rent</th>
                          <th className="py-2 pr-3">Annual Rent</th>
                          <th className="py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {unitTypes.map((r) => {
                          const u = Math.max(0, Math.floor(clampNum(r.units)));
                          const rent = Math.max(0, clampNum(r.rent));
                          const annual = u * rent * 12;
                          return (
                            <tr key={r.id} className="border-t border-slate-200">
                              <td className="py-2 pr-3">
                                <input
                                  value={r.name}
                                  onChange={(e) => updateUnitRow(r.id, { name: e.target.value })}
                                  className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                                />
                              </td>
                              <td className="py-2 pr-3">
                                <input
                                  value={r.units}
                                  onChange={(e) => updateUnitRow(r.id, { units: e.target.value })}
                                  className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                                  inputMode="numeric"
                                />
                              </td>
                              <td className="py-2 pr-3">
                                <div className="flex items-center gap-2">
                                  <input
                                    value={r.rent}
                                    onChange={(e) => updateUnitRow(r.id, { rent: e.target.value })}
                                    className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                                    inputMode="decimal"
                                  />
                                  <div className="text-slate-500">$</div>
                                </div>
                              </td>
                              <td className="py-2 pr-3">{usd0(annual)}</td>
                              <td className="py-2 text-right">
                                <button
                                  onClick={() => removeUnitRow(r.id)}
                                  className="rounded-2xl px-3 py-2 text-xs border border-slate-200 bg-white hover:bg-slate-100"
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        <tr className="border-t border-slate-200">
                          <td className="py-3 pr-3 font-semibold">Totals</td>
                          <td className="py-3 pr-3 font-semibold">{rentRoll.totalUnits.toLocaleString()}</td>
                          <td className="py-3 pr-3 text-slate-600">—</td>
                          <td className="py-3 pr-3 font-semibold">{usd0(rentRoll.gpr)}</td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </Card>
              ) : (
                <Card title="Revenue (Year 1)" subtitle="Non-multifamily placeholder — next we add $/SF rent, downtime, leasing.">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Annual Revenue (Year 1)" value={annualRevenue} onChange={setAnnualRevenue} suffix="$" />
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                      Coming next for {assetClass}: $/SF rent, occupancy, renewals, TI/LC, downtime.
                    </div>
                  </div>
                </Card>
              )}

              <Card
                title="Operating expenses"
                subtitle="Match Excel with Percent of Revenue, or use line-items/per-unit for real underwriting."
                right={
                  <select
                    value={opexMode}
                    onChange={(e) => setOpexMode(e.target.value as OpexMode)}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option>Percent of Revenue</option>
                    <option>Line Items</option>
                    <option>Per Unit / Year</option>
                    <option>Hybrid</option>
                  </select>
                }
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="OpEx (% of Revenue)" value={opexPctOfRev} onChange={setOpexPctOfRev} help="0.30 = 30%" />
                  <Field label="OpEx ($/unit/year)" value={opexPerUnitYear} onChange={setOpexPerUnitYear} />
                  <Field label="Expense Inflation (legacy)" value={expenseInflation} onChange={setExpenseInflation} help="Not used (model uses OpEx Growth)" />
                  <Field label="Mgmt Fee (% of Revenue)" value={mgmtFeePct} onChange={setMgmtFeePct} />
                  <Field label="Reserves ($/unit/year)" value={reservesPerUnitYear} onChange={setReservesPerUnitYear} />
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">Line items (optional)</div>
                    <div className="text-xs text-slate-600">Used in Line Items / Hybrid mode.</div>
                  </div>
                  <button
                    onClick={addOpexRow}
                    className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-200 bg-white hover:bg-slate-100"
                  >
                    + Add line item
                  </button>
                </div>

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-600">
                        <th className="py-2 pr-3">Expense</th>
                        <th className="py-2 pr-3">Annual ($)</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="border-t border-slate-200">
                      {opexItems.map((r) => (
                        <tr key={r.id} className="border-t border-slate-200">
                          <td className="py-2 pr-3">
                            <input
                              value={r.name}
                              onChange={(e) => updateOpexRow(r.id, { name: e.target.value })}
                              className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <input
                                value={r.annual}
                                onChange={(e) => updateOpexRow(r.id, { annual: e.target.value })}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                                inputMode="decimal"
                              />
                              <div className="text-slate-500">$</div>
                            </div>
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => removeOpexRow(r.id)}
                              className="rounded-2xl px-3 py-2 text-xs border border-slate-200 bg-white hover:bg-slate-100"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <Card title="Exit & debt" subtitle="Exit = NOIₙ₊₁ / Exit Cap. Debt = PMT + payoff at exit.">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Field label="Exit Cap Rate" value={exitCapRate} onChange={setExitCapRate} />
                  <Field label="Cost of Sale" value={costOfSalePct} onChange={setCostOfSalePct} help="0.004 = 0.4%" />
                  <Field label="LTV" value={ltv} onChange={setLtv} />
                  <Field label="Interest Rate" value={interestRate} onChange={setInterestRate} />
                  <Field label="Amortization (years)" value={amortYears} onChange={setAmortYears} />
                  <Field label="NPV Discount Rate" value={discountRate} onChange={setDiscountRate} />
                </div>
              </Card>
            </div>

            {/* Right rail */}
            <aside className="space-y-6">
              <Card
                title="Recommendation"
                subtitle="Based on DSCR + CoC + IRR (benchmarks adjustable later)."
                right={<Badge tone={model.recommendation.tone}>{model.recommendation.tone.toUpperCase()}</Badge>}
              >
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-lg font-semibold">{model.recommendation.headline}</div>
                  <div className="mt-2 text-sm text-slate-700">
                    Benchmarks: DSCR ~{fmt2(model.recommendation.benchmarks.dscr)}, CoC ~{fmtPct(model.recommendation.benchmarks.coc)}, IRR ~{fmtPct(model.recommendation.benchmarks.irr)}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3">
                  {model.recommendation.notes.map((n, i) => (
                    <div key={i} className="rounded-3xl border border-slate-200 p-4 bg-white">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold">{n.title}</div>
                        <Badge tone={n.tone}>{n.tone}</Badge>
                      </div>
                      <div className="mt-1 text-sm text-slate-700">{n.text}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Return summary" subtitle="Pitch-ready outputs.">
                <div className="space-y-3 text-sm">
                  <Row label="Go-in Cap Rate" value={fmtPct(model.capRate)} />
                  <Row label="DSCR (Y1)" value={fmt2(model.dscr)} />
                  <Row label="CoC (Y1)" value={fmtPct(model.coc)} />
                  <div className="pt-3 border-t border-slate-200" />
                  <Row label="Levered IRR" value={fmtPct(model.lIRR)} />
                  <Row label="Levered NPV" value={usd0(model.lNPV)} />
                  <div className="pt-3 border-t border-slate-200" />
                  <Row label="Exit NOI (N+1)" value={usd0(model.noi[model.N + 1])} />
                  <Row label="Exit Price" value={usd0(model.salePrice)} />
                  <Row label="Payoff" value={usd0(model.payoff)} />
                </div>
              </Card>

              <Card title="Deal name" subtitle="Used for Deal Library saves.">
                <Field label="Name" value={dealName} onChange={setDealName} placeholder="My Deal" />
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={saveDeal}
                    className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-900 bg-slate-900 text-white hover:opacity-90"
                  >
                    Save to Library
                  </button>
                  <button
                    onClick={() => setActiveTab("Deal Library")}
                    className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-200 bg-white hover:bg-slate-100"
                  >
                    View Library
                  </button>
                </div>
              </Card>
            </aside>
          </div>
        ) : null}

        {/* Sensitivity */}
        {activeTab === "Sensitivity" ? (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card
                title="Sensitivity table"
                subtitle="Purchase Price × Exit Cap Rate. Choose the metric you want to evaluate."
                right={
                  <select
                    value={sensMetric}
                    onChange={(e) => setSensMetric(e.target.value as SensMetric)}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option>Levered IRR</option>
                    <option>Levered NPV</option>
                    <option>CoC (Y1)</option>
                    <option>DSCR (Y1)</option>
                    <option>Exit Price</option>
                  </select>
                }
              >
                <div className="text-sm text-slate-700 mb-3">
                  Base Purchase Price: <b>{usd0(baseArgs.purchasePrice)}</b> • Base Exit Cap: <b>{fmtPct(baseArgs.exitCapRate)}</b>
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-[720px] w-full text-sm border-separate border-spacing-0">
                    <thead>
                      <tr>
                        <th className="sticky left-0 bg-white z-10 text-left p-3 border-b border-slate-200 font-semibold text-slate-700">
                          Exit Cap ↓ / Purchase Price →
                        </th>
                        {sensitivity.ppMultipliers.map((m, i) => (
                          <th key={i} className="p-3 border-b border-slate-200 text-slate-700 font-semibold">
                            {m === 0 ? "Base" : `${m > 0 ? "+" : ""}${Math.round(m * 100)}%`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sensitivity.exitCapDeltas.map((d, r) => {
                        const label = d === 0 ? "Base" : `${d > 0 ? "+" : ""}${Math.round(d * 10000)} bps`;
                        return (
                          <tr key={r} className="border-b border-slate-200">
                            <td className="sticky left-0 bg-white z-10 p-3 border-b border-slate-200 font-semibold text-slate-700">
                              {label}
                            </td>
                            {sensitivity.grid[r].map((v, c) => {
                              const isCenter = sensitivity.exitCapDeltas[r] === 0 && sensitivity.ppMultipliers[c] === 0;
                              return (
                                <td
                                  key={c}
                                  className={cn(
                                    "p-3 border-b border-slate-200 text-center",
                                    isCenter ? "bg-slate-900 text-white font-semibold rounded-2xl" : "bg-white"
                                  )}
                                >
                                  {metricFormat(sensMetric, v)}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 text-xs text-slate-600">
                  Classic IC-style grid. Great for presenting downside/upside.
                </div>
              </Card>

              <Card
                title="Tornado chart"
                subtitle="Shows which assumptions drive the most change in the metric (one-at-a-time)."
                right={
                  <select
                    value={tornadoMetric}
                    onChange={(e) => setTornadoMetric(e.target.value as SensMetric)}
                    className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm"
                  >
                    <option>Levered IRR</option>
                    <option>Levered NPV</option>
                    <option>CoC (Y1)</option>
                    <option>DSCR (Y1)</option>
                    <option>Exit Price</option>
                  </select>
                }
              >
                <div className="text-sm text-slate-700 mb-4">
                  Base {tornadoMetric}: <b>{metricFormat(tornadoMetric, tornado.baseV as any)}</b>
                </div>

                <div className="space-y-3">
                  {tornado.rows.map((r, idx) => {
                    const leftPct = r.dLow == null ? 0 : Math.min(100, (Math.abs(r.dLow) / tornado.maxSwing) * 100);
                    const rightPct = r.dHigh == null ? 0 : Math.min(100, (Math.abs(r.dHigh) / tornado.maxSwing) * 100);

                    return (
                      <div key={idx} className="rounded-3xl border border-slate-200 bg-white p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold">{r.name}</div>
                          <div className="text-xs text-slate-600">
                            Low: <b>{metricFormat(tornadoMetric, r.lowV as any)}</b> • High:{" "}
                            <b>{metricFormat(tornadoMetric, r.highV as any)}</b>
                          </div>
                        </div>

                        <div className="mt-3 grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-2 text-xs text-slate-600 text-right">Low</div>
                          <div className="col-span-4 h-3 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-3 bg-rose-300" style={{ width: `${leftPct}%` }} />
                          </div>

                          <div className="col-span-2 text-xs text-slate-600 text-center">Base</div>

                          <div className="col-span-4 h-3 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-3 bg-emerald-300" style={{ width: `${rightPct}%` }} />
                          </div>
                        </div>

                        <div className="mt-2 text-xs text-slate-500">
                          Red = downside sensitivity • Green = upside sensitivity
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            <aside className="space-y-6">
              <Card title="What’s included" subtitle="This build is now “demo-ready”.">
                <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
                  <li><b>Core underwriting engine</b> (unlevered + levered)</li>
                  <li><b>Sensitivity grid</b></li>
                  <li><b>Tornado drivers</b></li>
                  <li><b>Exports</b> (IC PDF, Math PDF, CSV)</li>
                  <li><b>Deal library</b> (save/load/rename/delete)</li>
                </ol>
              </Card>
            </aside>
          </div>
        ) : null}

        {/* Exports */}
        {activeTab === "Exports" ? (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card
                title="Export center"
                subtitle="PDF + CSV exports for underwriting review."
                right={
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => exportIcTearSheetPdf(model, baseArgs)}
                      className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-900 bg-slate-900 text-white hover:opacity-90"
                    >
                      Download IC PDF
                    </button>
                    <button
                      onClick={() => exportMathPdf(model, baseArgs)}
                      className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-200 bg-white hover:bg-slate-100"
                    >
                      Download Math PDF
                    </button>
                    <button
                      onClick={() => exportModelCsv(model)}
                      className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-200 bg-white hover:bg-slate-100"
                    >
                      Download CSV
                    </button>
                  </div>
                }
              >
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
                  <div className="font-semibold text-slate-900">Exports included</div>
                  <ul className="list-disc pl-5 mt-2 space-y-1">
                    <li><b>IC Tear Sheet PDF</b>: assumptions + returns + annual summary table</li>
                    <li><b>Math Reference PDF</b>: formulas + cash flow arrays (appendix)</li>
                    <li><b>CSV</b>: annual table + exit items for Excel</li>
                  </ul>

                  <div className="mt-4 text-xs text-slate-500">
                    Tip: Use IC PDF as the “front page” and Math PDF as the appendix.
                  </div>
                </div>
              </Card>
            </div>

            <aside className="space-y-6">
              <Card title="Return snapshot" subtitle="These should match the Underwrite panel.">
                <div className="space-y-3 text-sm">
                  <Row label="Levered IRR" value={fmtPct(model.lIRR)} />
                  <Row label="Levered NPV" value={usd0(model.lNPV)} />
                  <Row label="Exit Price" value={usd0(model.salePrice)} />
                  <Row label="Payoff" value={usd0(model.payoff)} />
                </div>
              </Card>
            </aside>
          </div>
        ) : null}

        {/* Deal Library */}
        {activeTab === "Deal Library" ? (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card
                title="Deal library"
                subtitle="Save, load, rename, and delete deals (localStorage)."
                right={
                  <button
                    onClick={saveDeal}
                    className="rounded-2xl px-4 py-2 text-sm font-medium border border-slate-900 bg-slate-900 text-white hover:opacity-90"
                  >
                    Save current deal
                  </button>
                }
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Current deal name" value={dealName} onChange={setDealName} />
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    Saved deals are stored in your browser. Next upgrade is accounts + cloud saves.
                  </div>
                </div>

                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-600">
                        <th className="py-2 pr-3">Name</th>
                        <th className="py-2 pr-3">Asset</th>
                        <th className="py-2 pr-3">Saved</th>
                        <th className="py-2 pr-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="border-t border-slate-200">
                      {savedDeals.length === 0 ? (
                        <tr className="border-t border-slate-200">
                          <td className="py-3 pr-3 text-slate-700" colSpan={4}>
                            No saved deals yet. Go to Underwrite and click <b>Save to Library</b>.
                          </td>
                        </tr>
                      ) : (
                        savedDeals.map((d) => (
                          <tr key={d.id} className="border-t border-slate-200">
                            <td className="py-2 pr-3">
                              <input
                                defaultValue={d.name}
                                onBlur={(e) => renameDeal(d.id, e.target.value)}
                                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
                              />
                            </td>
                            <td className="py-2 pr-3">{d.assetClass}</td>
                            <td className="py-2 pr-3">{new Date(d.createdAt).toLocaleString()}</td>
                            <td className="py-2 pr-3">
                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={() => loadDeal(d)}
                                  className="rounded-2xl px-3 py-2 text-xs border border-slate-900 bg-slate-900 text-white hover:opacity-90"
                                >
                                  Load
                                </button>
                                <button
                                  onClick={() => deleteDeal(d.id)}
                                  className="rounded-2xl px-3 py-2 text-xs border border-slate-200 bg-white hover:bg-slate-100"
                                >
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>

            <aside className="space-y-6">
              <Card title="Next upgrade" subtitle="When you’re ready to go real product.">
                <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-700">
                  <li>Auth + accounts</li>
                  <li>Cloud saved deals</li>
                  <li>Sharing links + permissions</li>
                  <li>Compare deals side-by-side</li>
                </ol>
              </Card>
            </aside>
          </div>
        ) : null}
      </main>

      <footer className="border-t border-slate-200 bg-white/70 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-6 text-xs text-slate-600">
          Prototype. Next: asset-class leasing modules (TI/LC/downtime), then partner splits.
        </div>
      </footer>
    </div>
  );
}

