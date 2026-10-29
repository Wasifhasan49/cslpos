"use client";

import * as React from "react";
import {
  CalendarCheck, Check, Clock, Plus, Users, Wallet, X,
} from "lucide-react";
import { useStaff } from "@/components/staff-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTaka } from "@/lib/sale";
import type {
  AttendanceDay, AttendanceStatus, Employee, LeaveRow, SalarySheet, SalarySheetRow,
  SettingRow,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type Tab = "people" | "attendance" | "leave" | "salary";

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "people", label: "People", icon: Users },
  { key: "attendance", label: "Attendance", icon: CalendarCheck },
  { key: "leave", label: "Leave", icon: Clock },
  { key: "salary", label: "Salary", icon: Wallet },
];

const STATUS_WORDS: Record<string, string> = {
  present: "In", late: "Late", absent: "Absent", leave: "On leave",
  holiday: "Shop shut", half_day: "Half a day", "not recorded": "Not recorded",
};

/**
 * Staff records: who works here, who was in, who is owed what.
 *
 * Everything on this screen needs the staff-records permission, and the salary tab
 * needs a second one — a shop can let a manager keep attendance without showing them
 * what anybody earns.
 */
export function HrScreen() {
  const { staff } = useStaff();
  const [tab, setTab] = React.useState<Tab>("people");
  const [error, setError] = React.useState("");
  const [note, setNote] = React.useState("");
  const [nonce, setNonce] = React.useState(0);

  const say = (e: unknown) => setError(e instanceof Error ? e.message : "That didn't work.");
  const done = (words: string) => {
    setError("");
    setNote(words);
    setNonce((n) => n + 1);
  };

  const canSeePay = staff.role === "owner";

  return (
    <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="no-print">
        <h1 className="text-xl font-semibold">Staff records</h1>
        <p className="text-[13px] text-muted">
          Everybody who works here — not only the people with a login.
        </p>
      </div>

      <nav className="no-print -mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Sections">
        {TABS.filter((t) => t.key !== "salary" || canSeePay).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTab(key); setError(""); setNote(""); }}
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl px-3 text-[15px]",
              tab === key ? "bg-ink text-white" : "bg-subtle text-ink-soft hover:bg-line")}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </nav>

      {error && <p role="alert" className="no-print text-bad-ink">{error}</p>}
      {note && (
        <p className="no-print flex items-center gap-2 rounded-xl border border-good-ink/30 bg-good-bg p-3 text-[15px] text-good-ink">
          <Check className="size-5 shrink-0" aria-hidden />
          {note}
        </p>
      )}

      {tab === "people" && <People key={nonce} onDone={done} onFail={say} />}
      {tab === "attendance" && <Attendance key={nonce} onDone={done} onFail={say} />}
      {tab === "leave" && <Leave key={nonce} onDone={done} onFail={say} />}
      {tab === "salary" && canSeePay && <Salary key={nonce} onDone={done} onFail={say} />}
    </main>
  );
}

function People({ onDone, onFail }: { onDone: (s: string) => void; onFail: (e: unknown) => void }) {
  const { backend, branch, branches, staff } = useStaff();
  const [rows, setRows] = React.useState<Employee[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [lists, setLists] = React.useState<Record<string, SettingRow[]>>({});
  const [departmentId, setDepartmentId] = React.useState("");
  const [designationId, setDesignationId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const canSeePay = staff.role === "owner";

  React.useEffect(() => {
    backend.listEmployees().then(setRows).catch(onFail);
    // The setup lists come in the one settings bundle, like everywhere else.
    backend.loadSettings()
      .then((s) => setLists({ departments: s.lists.departments ?? [],
                              designations: s.lists.designations ?? [] }))
      .catch(() => setLists({}));
  }, [backend, onFail]);

  const save = async () => {
    setBusy(true);
    try {
      await backend.saveEmployee(null, {
        name, phone: phone || null, branch_id: branch.id,
        department_id: departmentId || null, designation_id: designationId || null,
      });
      setAdding(false);
      setName("");
      setPhone("");
      onDone(`${name} is on the staff list.`);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  return (
    <>
      {!adding && (
        <div>
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden /> Add somebody
          </Button>
        </div>
      )}
      {adding && (
        <section className="rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] text-muted">
              Name
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex w-[180px] flex-col gap-1 text-[13px] text-muted">
              Phone
              <Input value={phone} onChange={(e) => setPhone(e.target.value)}
                     placeholder="01700-000000" />
            </label>
            <label className="flex w-[180px] flex-col gap-1 text-[13px] text-muted">
              Department
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
                      className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]">
                <option value="">—</option>
                {(lists.departments ?? []).map((d) => (
                  <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>
                ))}
              </select>
            </label>
            <label className="flex w-[180px] flex-col gap-1 text-[13px] text-muted">
              Job title
              <select value={designationId} onChange={(e) => setDesignationId(e.target.value)}
                      className="min-h-[44px] rounded-xl border border-line bg-white px-3 text-[15px]">
                <option value="">—</option>
                {(lists.designations ?? []).map((d) => (
                  <option key={String(d.id)} value={String(d.id)}>{String(d.name)}</option>
                ))}
              </select>
            </label>
            <Button onClick={save} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          <p className="mt-2 text-[13px] text-muted">
            An employee does not need a login. Link one later if this person uses the till.
          </p>
        </section>
      )}

      {!rows && <p className="text-[15px] text-muted">Loading…</p>}
      {rows?.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-6 text-[15px] text-muted">
          Nobody on the list yet.
        </p>
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="p-3 font-normal">Name</th>
                <th className="p-3 font-normal">Job</th>
                <th className="p-3 font-normal">Branch</th>
                <th className="p-3 font-normal">Joined</th>
                <th className="p-3 font-normal">Today</th>
                {canSeePay && <th className="p-3 text-right font-normal">Monthly</th>}
                {canSeePay && <th className="p-3 text-right font-normal">Advance owed</th>}
                {canSeePay && <th className="p-3 font-normal">What they earn</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-line/60">
                  <td className="p-3">
                    {e.name}
                    <span className="block text-[12px] text-muted">
                      {e.phone ?? "no phone"}
                      {e.login && ` · signs in as ${e.login}`}
                    </span>
                  </td>
                  <td className="p-3">{e.designation ?? "—"}</td>
                  <td className="p-3">{e.branch ?? "—"}</td>
                  <td className="p-3 num">{e.joinedOn}</td>
                  <td className="p-3">{e.today ? STATUS_WORDS[e.today] : "Not recorded"}</td>
                  {canSeePay && (
                    <td className="p-3 text-right num">
                      {e.basic === null ? "—" : formatTaka(
                        e.basic + Object.values(e.allowances ?? {}).reduce((n, v) => n + Number(v), 0))}
                    </td>
                  )}
                  {canSeePay && (
                    <td className="p-3 text-right num">
                      {e.advanceOutstanding ? formatTaka(e.advanceOutstanding) : "—"}
                    </td>
                  )}
                  {canSeePay && (
                    <td className="p-3">
                      <Pay employee={e} onDone={onDone} onFail={onFail} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {branches.length > 1 && (
        <p className="text-[13px] text-muted">
          Showing everybody. Each person belongs to one branch.
        </p>
      )}
    </>
  );
}

/** What somebody earns, and lending against it. Owner only, in the database too. */
function Pay({ employee, onDone, onFail }: {
  employee: Employee;
  onDone: (s: string) => void;
  onFail: (e: unknown) => void;
}) {
  const { backend } = useStaff();
  const [open, setOpen] = React.useState(false);
  const [basic, setBasic] = React.useState(String(employee.basic ?? 0));
  const [house, setHouse] = React.useState(String(employee.allowances?.["House rent"] ?? 0));
  const [advance, setAdvance] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (!open) {
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {employee.basic ? "Change it" : "Set it"}
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex w-[110px] flex-col gap-1 text-[13px] text-muted">
        Basic
        <Input inputMode="numeric" className="num" value={basic}
               onChange={(e) => setBasic(e.target.value)} />
      </label>
      <label className="flex w-[110px] flex-col gap-1 text-[13px] text-muted">
        House rent
        <Input inputMode="numeric" className="num" value={house}
               onChange={(e) => setHouse(e.target.value)} />
      </label>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await backend.saveSalaryTerms(employee.id, {
              basic: Number(basic) || 0,
              allowances: Number(house) > 0 ? { "House rent": Number(house) } : {},
            });
            setOpen(false);
            onDone(`${employee.name} earns ${formatTaka((Number(basic) || 0) + (Number(house) || 0))} a month.`);
          } catch (e) { onFail(e); } finally { setBusy(false); }
        }}
      >
        Save
      </Button>
      <label className="flex w-[120px] flex-col gap-1 text-[13px] text-muted">
        Lend them
        <Input inputMode="numeric" className="num" value={advance}
               onChange={(e) => setAdvance(e.target.value)} placeholder="Advance" />
      </label>
      <Button
        variant="outline"
        disabled={busy || !(Number(advance) > 0)}
        onClick={async () => {
          setBusy(true);
          try {
            await backend.recordSalaryAdvance(employee.id, Number(advance) || 0, "cash");
            setAdvance("");
            setOpen(false);
            onDone("Advance recorded. It comes off the next salary sheet.");
          } catch (e) { onFail(e); } finally { setBusy(false); }
        }}
      >
        Give an advance
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

function Attendance({ onDone, onFail }: { onDone: (s: string) => void; onFail: (e: unknown) => void }) {
  const { backend, branch } = useStaff();
  const [day, setDay] = React.useState<AttendanceDay | null>(null);
  const [date, setDate] = React.useState("");
  const [pin, setPin] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    backend.attendanceDay(date || null, null).then(setDay).catch(onFail);
  }, [backend, date, onFail]);
  React.useEffect(load, [load]);

  const mark = async (employeeId: string, status: AttendanceStatus) => {
    setBusy(true);
    try {
      await backend.markAttendance(employeeId, day?.date ?? date, status);
      onDone("Marked.");
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  return (
    <>
      <BranchSettings onDone={onDone} onFail={onFail} />

      <section className="rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold">I&rsquo;m in</h2>
        <p className="mt-1 text-[13px] text-muted">
          Type the code this branch keeps. It records that you checked in <em>at the
          branch</em>, today — which is what attendance is for. It is not proof you were
          here, and a manager can mark somebody in as well.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex w-[160px] flex-col gap-1 text-[13px] text-muted">
            Branch code
            <Input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric"
                   className="num" />
          </label>
          <Button
            disabled={busy || !pin}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await backend.checkIn(branch.id, pin);
                setPin("");
                onDone(r.status === "late"
                  ? `${r.employee} checked in ${r.minutesLate} minutes after ${r.opensAt}.`
                  : `${r.employee} checked in at ${r.branch}.`);
              } catch (e) { onFail(e); } finally { setBusy(false); }
            }}
          >
            Check in
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await backend.checkOut(branch.id);
                onDone("Checked out.");
              } catch (e) { onFail(e); } finally { setBusy(false); }
            }}
          >
            Check out
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[13px] text-muted">
          Which day
          <Input type="date" value={date || (day?.date ?? "")}
                 onChange={(e) => setDate(e.target.value)} />
        </label>
        {day && (
          <p className="min-h-[44px] pt-3 text-[15px]">
            <strong className="num">{day.counts.present}</strong> in ·{" "}
            <strong className="num">{day.counts.late}</strong> late ·{" "}
            <strong className="num">{day.counts.absent}</strong> absent ·{" "}
            <strong className="num">{day.counts.leave}</strong> on leave
            {day.counts.notRecorded > 0 && (
              <span className="text-bad-ink">
                {" "}· <strong className="num">{day.counts.notRecorded}</strong> not recorded
              </span>
            )}
          </p>
        )}
      </div>

      {day && (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="p-3 font-normal">Name</th>
                <th className="p-3 font-normal">In</th>
                <th className="p-3 font-normal">Out</th>
                <th className="p-3 font-normal">Where it stands</th>
                <th className="p-3 font-normal">How</th>
                <th className="p-3 font-normal">Mark them</th>
              </tr>
            </thead>
            <tbody>
              {day.people.map((p) => (
                <tr key={p.employeeId} className="border-b border-line/60">
                  <td className="p-3">
                    {p.name}
                    <span className="block text-[12px] text-muted">{p.branch ?? "—"}</span>
                  </td>
                  <td className="p-3 num">
                    {p.inAt ? new Date(p.inAt).toLocaleTimeString("en-GB",
                      { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className="p-3 num">
                    {p.outAt ? new Date(p.outAt).toLocaleTimeString("en-GB",
                      { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </td>
                  <td className={cn("p-3", p.status === "absent" && "text-bad-ink",
                                   p.status === "not recorded" && "text-muted")}>
                    {STATUS_WORDS[p.status] ?? p.status}
                    {p.minutesLate > 0 && (
                      <span className="block text-[12px] text-muted">
                        {p.minutesLate} minutes late
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-[13px] text-muted">
                    {p.source === "self" ? "Checked in" : p.source === "manager"
                      ? `Marked by ${p.markedBy ?? "a manager"}` : "—"}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1">
                      {(["present", "late", "absent", "half_day"] as AttendanceStatus[]).map((s) => (
                        <Button
                          key={s}
                          variant="ghost"
                          disabled={busy || p.status === s}
                          onClick={() => mark(p.employeeId, s)}
                        >
                          {STATUS_WORDS[s]}
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** When this branch opens, and the code it takes check-ins with. */
function BranchSettings({ onDone, onFail }: {
  onDone: (s: string) => void; onFail: (e: unknown) => void;
}) {
  const { backend, branch } = useStaff();
  const [open, setOpen] = React.useState(false);
  const [opensAt, setOpensAt] = React.useState("10:00");
  const [grace, setGrace] = React.useState("15");
  const [pin, setPin] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Set {branch.name}&rsquo;s opening time and code
        </Button>
      </div>
    );
  }
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <h2 className="font-semibold">{branch.name}</h2>
      <p className="mt-1 text-[13px] text-muted">
        Anybody arriving more than the grace period after opening is marked late. Leave
        the code empty and this branch takes no check-ins at all — a manager marks
        attendance instead.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex w-[130px] flex-col gap-1 text-[13px] text-muted">
          Opens at
          <Input type="time" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />
        </label>
        <label className="flex w-[130px] flex-col gap-1 text-[13px] text-muted">
          Grace (minutes)
          <Input inputMode="numeric" className="num" value={grace}
                 onChange={(e) => setGrace(e.target.value)} />
        </label>
        <label className="flex w-[150px] flex-col gap-1 text-[13px] text-muted">
          Check-in code
          <Input inputMode="numeric" className="num" value={pin}
                 onChange={(e) => setPin(e.target.value)} placeholder="4 to 8 digits" />
        </label>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await backend.saveAttendanceSettings(branch.id, {
                opens_at: opensAt, grace_minutes: Number(grace) || 0,
                attendance_pin: pin,
              });
              setOpen(false);
              onDone(r.takesCheckIns
                ? `${branch.name} opens at ${r.opensAt} and takes check-ins.`
                : `${branch.name} opens at ${r.opensAt}. A manager marks attendance here.`);
            } catch (e) { onFail(e); } finally { setBusy(false); }
          }}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

function Leave({ onDone, onFail }: { onDone: (s: string) => void; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [rows, setRows] = React.useState<LeaveRow[] | null>(null);
  const [asking, setAsking] = React.useState<string | null>(null);
  const [why, setWhy] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    backend.listLeave().then(setRows).catch(onFail);
  }, [backend, onFail]);

  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    try {
      await backend.decideLeave(id, approve, approve ? null : why);
      setAsking(null);
      setWhy("");
      onDone(approve
        ? "Approved — those days are marked as leave, so the salary sheet will not dock them."
        : "Refused.");
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  if (!rows) return <p className="text-[15px] text-muted">Loading…</p>;
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-6 text-[15px] text-muted">
        Nobody has asked for leave.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <section key={r.id} className="rounded-xl border border-line bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[15px] font-medium">
                {r.employee} · {r.kind}
                {!r.isPaid && <span className="text-muted"> (unpaid)</span>}
              </p>
              <p className="text-[13px] text-muted">
                <span className="num">{r.fromDate}</span> to <span className="num">{r.toDate}</span>
                {" · "}<span className="num">{r.days}</span> days
                {r.daysAYear > 0 && ` · ${r.takenThisYear} of ${r.daysAYear} used this year`}
              </p>
              {r.reason && <p className="mt-1 text-[14px]">{r.reason}</p>}
              {r.note && <p className="mt-1 text-[13px] text-muted">{r.note}</p>}
            </div>
            <div className="flex gap-2">
              {r.status === "asked" ? (
                asking === r.id ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="flex flex-col gap-1 text-[13px] text-muted">
                      Why not?
                      <Input value={why} onChange={(e) => setWhy(e.target.value)} />
                    </label>
                    <Button onClick={() => decide(r.id, false)} disabled={busy}>Refuse it</Button>
                    <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
                  </div>
                ) : (
                  <>
                    <Button onClick={() => decide(r.id, true)} disabled={busy}>Approve</Button>
                    <Button variant="ghost" onClick={() => { setAsking(r.id); setWhy(""); }}>
                      Refuse
                    </Button>
                  </>
                )
              ) : (
                <span className="text-[14px] text-muted">
                  {r.status === "approved" ? "Approved" : r.status === "refused" ? "Refused" : "Called off"}
                  {r.decidedBy && ` by ${r.decidedBy}`}
                </span>
              )}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function Salary({ onDone, onFail }: { onDone: (s: string) => void; onFail: (e: unknown) => void }) {
  const { backend } = useStaff();
  const [sheets, setSheets] = React.useState<SalarySheetRow[]>([]);
  const [open, setOpen] = React.useState<SalarySheet | null>(null);
  const [month, setMonth] = React.useState(lastMonth());
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    backend.listSalarySheets().then(setSheets).catch(onFail);
  }, [backend, onFail]);
  React.useEffect(load, [load]);

  const build = async () => {
    setBusy(true);
    try {
      const r = await backend.buildSalarySheet(`${month}-01`);
      setOpen(await backend.salarySheet(r.id));
      load();
      onDone(`${r.employees} people, ${formatTaka(r.total)} in all.`);
    } catch (e) { onFail(e); } finally { setBusy(false); }
  };

  return (
    <>
      <section className="no-print rounded-xl border border-line bg-white p-4">
        <h2 className="font-semibold">Work out a month</h2>
        <p className="mt-1 text-[13px] text-muted">
          Basic and allowances, less a day&rsquo;s pay for each day marked absent, less any
          advance still outstanding. A day nobody marked is not a day absent.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[13px] text-muted">
            Month
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <Button onClick={build} disabled={busy}>
            {busy ? "Working it out…" : "Work it out"}
          </Button>
        </div>
      </section>

      {sheets.length > 0 && !open && (
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-line text-left text-[13px] text-muted">
                <th className="p-3 font-normal">Month</th>
                <th className="p-3 font-normal">People</th>
                <th className="p-3 text-right font-normal">Total</th>
                <th className="p-3 font-normal">Where it stands</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer border-b border-line/60 hover:bg-subtle"
                  onClick={() => backend.salarySheet(s.id).then(setOpen).catch(onFail)}
                >
                  <td className="p-3 num">{s.month.slice(0, 7)}</td>
                  <td className="p-3 num">{s.people}</td>
                  <td className="p-3 text-right num">{formatTaka(s.total)}</td>
                  <td className="p-3">
                    {s.status === "paid" ? `Paid ${s.paidOn}` : "Not paid yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <section className="rounded-xl border border-line bg-white">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4">
            <div>
              <h2 className="font-semibold">Salary for {open.month.slice(0, 7)}</h2>
              <p className="text-[13px] text-muted">
                {open.lines.length} people · {open.status === "paid"
                  ? `paid ${open.paidOn} by ${open.method}` : "not paid yet"}
              </p>
            </div>
            <Button variant="ghost" onClick={() => setOpen(null)} aria-label="Close">
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          <div id="print-report" className="overflow-x-auto">
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line text-left text-[13px] text-muted">
                  <th className="p-3 font-normal">Name</th>
                  <th className="p-3 text-right font-normal">Basic</th>
                  <th className="p-3 text-right font-normal">Allowances</th>
                  <th className="p-3 text-right font-normal">Days worked</th>
                  <th className="p-3 text-right font-normal">Absent</th>
                  <th className="p-3 text-right font-normal">Less absence</th>
                  <th className="p-3 text-right font-normal">Less advance</th>
                  <th className="p-3 text-right font-normal">Net</th>
                </tr>
              </thead>
              <tbody>
                {open.lines.map((l) => (
                  <tr key={l.id} className="border-b border-line/60">
                    <td className="p-3">
                      {l.employee}
                      <span className="block text-[12px] text-muted">{l.designation ?? "—"}</span>
                    </td>
                    <td className="p-3 text-right num">{formatTaka(l.basic)}</td>
                    <td className="p-3 text-right num">{formatTaka(l.allowances)}</td>
                    <td className="p-3 text-right num">{l.daysWorked}</td>
                    <td className="p-3 text-right num">{l.absentDays || "—"}</td>
                    <td className="p-3 text-right num">
                      {l.absenceCut ? formatTaka(l.absenceCut) : "—"}
                    </td>
                    <td className="p-3 text-right num">
                      {l.advanceCut ? formatTaka(l.advanceCut) : "—"}
                    </td>
                    <td className="p-3 text-right num font-semibold">{formatTaka(l.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink font-semibold">
                  <td className="p-3" colSpan={7}>Total</td>
                  <td className="p-3 text-right num">{formatTaka(open.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="no-print flex flex-wrap gap-2 border-t border-line p-4">
            <Button variant="outline" onClick={() => window.print()}>Print the slips</Button>
            {open.status === "draft" && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await backend.paySalarySheet(open.id, "cash");
                    setOpen(await backend.salarySheet(open.id));
                    load();
                    onDone(`${formatTaka(r.total)} paid. It is on the books as a running cost, and out of the drawer.`);
                  } catch (e) { onFail(e); } finally { setBusy(false); }
                }}
              >
                Pay it, in cash
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
