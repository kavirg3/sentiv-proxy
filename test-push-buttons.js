// Hub v242 — owner-editable button names on every notification. Run: node test-push-buttons.js
process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const R = require("./push-routes");
const fails = [];
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); if (!c) fails.push(n); };
const titles = (p) => (p.actions || []).map((a) => a.title).join(" | ");

const lead = { id: "L1", agent_id: "a1", data: { company: "Mthembu Logistics", value: 84500, stage: "Closed Won" } };
const people = [{ id: "o1", role: "owner" }, { id: "a1", role: "agent" }];
const won = (tpls) => R._wonPayloads(lead, { tpls, phones: { a1: "0825550172" }, monthTotal: 1, agentName: "Thabo", people })[0].payload;

check("won: shipped names when nothing set", titles(won({})) === "Open deal | Reply in WhatsApp", titles(won({})));
check("won: owner's names used", titles(won({ won: { btns: { open: "View the deal", wa: "Congratulate Thabo" } } })) === "View the deal | Congratulate Thabo");
check("won: blank name = shipped", titles(won({ won: { btns: { open: "  ", wa: "Say well done" } } })) === "Open deal | Say well done");
check("won: what the button does is unchanged", won({ won: { btns: { open: "X", wa: "Y" } } }).actions.map((a) => a.action).join() === "open,wa");
check("won: long name capped at 30", won({ won: { btns: { open: "a".repeat(80) } } }).actions[0].title.length === 30);
check("won: junk ignored", titles(won({ won: { btns: "nonsense" } })) === "Open deal | Reply in WhatsApp");

const fu = R._payloadFor({ id: "F1", data: { company: "Acme", stage: "Lead" } }, "followup", { followup: { btns: { snooze: "Later" } } });
check("follow-up: buttons sent explicitly, snooze renamed", titles(fu) === "Open lead | Later", titles(fu));
const st = R._payloadFor({ id: "S1", data: { company: "Acme", updatedAt: Date.now() - 9 * 864e5 } }, "stale", {});
check("going cold: shipped Open lead + Snooze", titles(st) === "Open lead | Snooze", titles(st));
const q = R._quotePayload({ id: "Q1", data: { company: "Acme", phone: "082 555 0172", contact: "Sipho", updatedAt: Date.now() - 6 * 864e5 } }, { quote: { btns: { wa: "Nudge on WhatsApp" } } });
check("quote: WhatsApp button renamed", titles(q) === "Open lead | Nudge on WhatsApp", titles(q));
const rm = R._remindPayload({ id: "r", text: "Call Sipho", time: "09:00" }, { remind: { btns: { snooze: "Got it" } } });
check("reminder: Done renamed", titles(rm) === "Open Hub | Got it", titles(rm));
const other = R._wonPayloads(lead, { tpls: { quote: { btns: { open: "Q only" } } }, phones: {}, people })[0].payload;
check("one alert's names don't leak to another", titles(other) === "Open deal | Reply in WhatsApp");

// v243 — where a button goes
const wl = won({ won: { links: { open: "https://example.com/deals?c={company}", wa: "https://chat.whatsapp.com/ABC123" } } });
check("link: owner's links sent per button", wl.links && wl.links.open === "https://example.com/deals?c=Mthembu%20Logistics" && wl.links.wa === "https://chat.whatsapp.com/ABC123", JSON.stringify(wl.links));
check("link: none set = no links field", won({}).links === undefined);
check("link: http / javascript refused", won({ won: { links: { open: "http://x.com", wa: "javascript:alert(1)" } } }).links === undefined);
check("link: one alert's link doesn't leak", R._payloadFor({ id: "F1", data: {} }, "followup", { won: { links: { open: "https://a.com" } } }).links === undefined);
const fl = R._payloadFor({ id: "F1", data: { company: "Acme" } }, "followup", { followup: { links: { snooze: "https://cal.com/x" } } });
check("link: follow-up snooze button can carry a link", fl.links && fl.links.snooze === "https://cal.com/x");

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
