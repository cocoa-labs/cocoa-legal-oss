// backend/src/lib/calendar/deadlines.test.ts
//
// classifyDeadline turns a deadline's text into a legal deadline TYPE and a
// default reminder lead time, so Quill can file court dates / statutes /
// filing deadlines on the firm calendar with sensible lead-time reminders
// without the user spelling out every field. Pure function → straight asserts.
import assert from "node:assert/strict";
import { classifyDeadline, DEADLINE_LEAD_DAYS } from "./deadlines";

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ok — ${name}`);
    } catch (err) {
        console.error(`  FAIL — ${name}`);
        throw err;
    }
}

function main(): void {
    console.log("calendar/deadlines.test.ts");

    test("statute-of-limitations keywords → statute_of_limitations + 30d lead", () => {
        const r = classifyDeadline({ text: "Statute of limitations — Doe v. Roe" });
        assert.equal(r.type, "statute_of_limitations");
        assert.equal(r.leadDays, DEADLINE_LEAD_DAYS.statute_of_limitations);
        assert.equal(r.leadDays, 30);
    });

    test("filing keywords → filing + 10d lead", () => {
        assert.equal(classifyDeadline({ text: "Filing deadline — Acme MSA" }).type, "filing");
        assert.equal(classifyDeadline({ text: "Answer due to the court" }).type, "filing");
        assert.equal(classifyDeadline({ text: "Filing deadline" }).leadDays, 10);
    });

    test("hearing/trial/court keywords → court_date + 7d lead", () => {
        assert.equal(classifyDeadline({ text: "Motion hearing" }).type, "court_date");
        assert.equal(classifyDeadline({ text: "Jury trial begins" }).type, "court_date");
        assert.equal(classifyDeadline({ text: "Deposition of plaintiff" }).type, "court_date");
        assert.equal(classifyDeadline({ text: "Status conference" }).leadDays, 7);
    });

    test("unknown text → other + 3d lead", () => {
        const r = classifyDeadline({ text: "Reminder to review the binder" });
        assert.equal(r.type, "other");
        assert.equal(r.leadDays, 3);
    });

    test("an explicit type wins over the keyword guess", () => {
        const r = classifyDeadline({
            text: "hearing",
            explicitType: "filing",
        });
        assert.equal(r.type, "filing");
    });

    test("an explicit lead time wins over the default", () => {
        const r = classifyDeadline({ text: "Filing deadline", explicitLeadDays: 21 });
        assert.equal(r.type, "filing");
        assert.equal(r.leadDays, 21);
    });

    test("a non-positive explicit lead time falls back to the default", () => {
        assert.equal(classifyDeadline({ text: "Filing deadline", explicitLeadDays: 0 }).leadDays, 10);
        assert.equal(classifyDeadline({ text: "Filing deadline", explicitLeadDays: -5 }).leadDays, 10);
    });

    console.log("calendar/deadlines.test.ts: all passed");
}

main();
