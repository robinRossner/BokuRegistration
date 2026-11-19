// Runs the userscript in jsdom against a page modelled on the real sa2.auswahl and sa9 pages.
// Run with: npm test
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM, VirtualConsole } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "../boku-registrator.user.js"), "utf8");
const SA2 = "https://online.boku.ac.at/BOKUonline/sa2.auswahl?clvnr=1&csave=";
const SA9 = "https://online.boku.ac.at/BOKUonline/sa9.lvAnmeldInfoSeite?pStpSpNr=1";
const GROUP = 100000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buttonHtml = (name, extraDialog = false) =>
	`<button id="btn0003" onclick="studAnmelden('${name}','LV','Studium','elid3',${GROUP},'',${extraDialog},'100001',false,false);return false;">Anmelden</button>`;

const selectionPage = ({ button = "", shownName, toGo = -1 } = {}) => `<body>
	<form action="sa2.auswahl" method="post"><input type="hidden" name="cgrpnr"><input type="hidden" name="csave"><input type="hidden" name="cabgrppersnr"><input type="hidden" name="pLVGrpProfNr"><input type="hidden" name="pPHOrgNr"><input type="hidden" name="pPHOrgName"><input type="hidden" name="pPHOrgKennung"></form>
	<table><tr><td><a href="sa3.detailLVGrp?pLVGrpNr=${GROUP}&pOrgNr=1">Group 3</a></td><td>${button}</td><td>08.07.26,00:00</td></tr></table>
	<div id="box"><div id="CONFIRM_DIV_MESSAGE"></div><div id="CONFIRM_DIV_LV_GRP"></div>
	<button id="ok" onclick="document.forms[0].submit();">OK</button><button>Abbrechen</button></div>
	<script>
		var vCountUp = 0, vGrpAnmeldToGo = new Array();
		vGrpAnmeldToGo[${GROUP}] = ${toGo};
		var opened = 0;
		function studAnmelden(name, lv, st, id, grp, qu, extraDialog) {
			if (extraDialog || vCountUp < vGrpAnmeldToGo[grp]) return;
			opened++;
			document.getElementById("CONFIRM_DIV_MESSAGE").innerHTML = "Wollen Sie sich wirklich ANmelden?";
			document.getElementById("CONFIRM_DIV_LV_GRP").innerHTML = ${shownName ? `"${shownName}"` : "name"};
			var f = document.forms[0].elements; f.cgrpnr.value = grp; f.csave.value = "J";
		}
	</script></body>`;

const resultPage = (status) => `<body><table><tr><th>Gruppe</th></tr><tr><td>Group 3</td><td>${status}</td></tr></table></body>`;

// Loads the page with an optional stored task, stubbing form submits, navigation and fetch
const load = async (url, html, task, fetchPages = [], requestGap = 5) => {
	const virtualConsole = new VirtualConsole();
	const navigations = [];
	virtualConsole.on("jsdomError", (error) => {
		if (/navigation/i.test(error.message)) navigations.push(error.message);
	});
	const dom = new JSDOM(html, { url, runScripts: "dangerously", virtualConsole, pretendToBeVisual: true });
	const { window } = dom;
	window.submits = [];
	window.HTMLFormElement.prototype.submit = function () {
		window.submits.push({ cgrpnr: this.elements.cgrpnr.value, csave: this.elements.csave.value });
		window.lastSignupId = this.elements.cabgrppersnr.value;
	};
	window.fetchCount = 0;
	window.fetch = typeof fetchPages === "function" ? fetchPages : async () => {
		const page = fetchPages[Math.min(window.fetchCount++, fetchPages.length - 1)];
		return { ok: true, url, text: async () => page };
	};
	if (task) window.sessionStorage.setItem("bokuRegistratorTask", JSON.stringify(task));
	window.eval(SCRIPT.replace("MIN_REQUEST_MS = 5200", `MIN_REQUEST_MS = ${requestGap}`));
	return { window, navigations };
};

const task = (extra = {}) => ({
	courseId: "1",
	url: SA2,
	group: String(GROUP),
	name: "Group 3",
	opens: Date.now() - 1000,
	mode: "register",
	dry: false,
	phase: "armed",
	...extra
});
const status = (window) => window.document.getElementById("boku-reg-status").textContent;

test("setup panel lists the group and its opening time", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3") }));
	assert.strictEqual(window.document.getElementById("boku-reg-group").options[0].text, "Group 3");
	assert.strictEqual(window.document.getElementById("boku-reg-time").value, "2026-07-08T00:00");
	window.close();
});

test("open page: clicks through and submits the right group", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3") }), task());
	await sleep(20);
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "J" }]);
	window.close();
});

test("test run stops before OK", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3") }), task({ dry: true }));
	await sleep(20);
	assert.strictEqual(window.opened, 1);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /Test run OK/);
	window.close();
});

test("on a loaded page, waits for the site's countdown without any requests", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3"), toGo: 5 }), task());
	await sleep(100);
	assert.strictEqual(window.opened, 0);
	assert.strictEqual(window.fetchCount, 0);
	window.vCountUp = 5;
	await sleep(100);
	assert.strictEqual(window.submits.length, 1);
	window.close();
});

test("a fetched countdown submits once at the opening, without more requests", async () => {
	const closed = selectionPage();
	const counting = selectionPage({ button: buttonHtml("Group 3"), toGo: 1 });
	const { window } = await load(SA2, closed, task(), [closed, counting]);
	await sleep(300);
	assert.deepStrictEqual(window.submits, []);
	await sleep(1000);
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "J" }]);
	assert.strictEqual(window.fetchCount, 2);
	window.close();
});

test("keeps to BOKU's request limit", async () => {
	const { window } = await load(SA2, selectionPage(), task(), [selectionPage()], 5200);
	await sleep(200);
	assert.strictEqual(window.fetchCount, 0);
	window.close();
});

test("treats BOKU's wait page as a pause, not an expired login", async () => {
	const { window } = await load(SA2, selectionPage(), task());
	let calls = 0;
	window.fetch = async () => {
		calls++;
		return { ok: true, url: "https://online.boku.ac.at/BOKUonline/sa3.waitpage", text: async () => "<body>Bitte warten</body>" };
	};
	await sleep(100);
	assert.ok(calls > 3);
	assert.doesNotMatch(status(window), /expired/);
	window.close();
});

test("does not act before the polling window", async () => {
	const { window } = await load(
		SA2,
		selectionPage({ button: buttonHtml("Group 3") }),
		task({ opens: Date.now() + 3600 * 1000 })
	);
	await sleep(50);
	assert.strictEqual(window.opened, 0);
	assert.strictEqual(window.fetchCount, 0);
	window.close();
});

test("submits directly when the button appears, without loading the page", async () => {
	const closed = selectionPage();
	const open = selectionPage({ button: buttonHtml("Group 3") });
	const { window, navigations } = await load(SA2, closed, task(), [closed, closed, open]);
	await sleep(100);
	assert.strictEqual(window.fetchCount, 3);
	assert.strictEqual(navigations.length, 0);
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "J" }]);
	assert.strictEqual(JSON.parse(window.sessionStorage.getItem("bokuRegistratorTask")).phase, "submitted");
	window.close();
});

test("loads the page instead when the button needs extra fields", async () => {
	const closed = selectionPage();
	const open = selectionPage({ button: buttonHtml("Group 3", true) });
	const { window, navigations } = await load(SA2, closed, task({ url: `${SA2}&reloaded=1` }), [closed, open]);
	await sleep(100);
	assert.strictEqual(navigations.length, 1);
	assert.deepStrictEqual(window.submits, []);
	window.close();
});

test("a test run loads the page instead of submitting", async () => {
	const closed = selectionPage();
	const open = selectionPage({ button: buttonHtml("Group 3") });
	const { window, navigations } = await load(SA2, closed, task({ dry: true, url: `${SA2}&reloaded=1` }), [closed, open]);
	await sleep(100);
	assert.strictEqual(navigations.length, 1);
	assert.deepStrictEqual(window.submits, []);
	window.close();
});

test("does not count a failed request as an expired login", async () => {
	const { window } = await load(SA2, selectionPage(), task());
	window.fetch = async () => ({ ok: false, url: SA2, text: async () => "" });
	await sleep(50);
	assert.doesNotMatch(status(window), /expired/);
	window.close();
});

test("stops when the login seems expired", async () => {
	const { window } = await load(SA2, selectionPage(), task({ opens: Date.now() }), ["<body>Login</body>"]);
	await sleep(2300);
	assert.match(status(window), /Login seems to have expired/);
	window.close();
});

test("stops when the site opens a different dialog", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3", true) }), task());
	await sleep(20);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /Finish by hand/);
	window.close();
});

test("stops when the dialog names another group", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3"), shownName: "Group 2" }), task());
	await sleep(20);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /Stopped/);
	window.close();
});

test("never resubmits after returning to the selection page", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3") }), task({ phase: "submitted" }));
	await sleep(20);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /not confirmed/);
	window.close();
});

test("result page reports FIXPLATZ and a waiting list differently", async () => {
	const fixed = await load(SA9, resultPage("FIXPLATZ"), task({ phase: "submitted" }));
	assert.match(status(fixed.window), /FIXPLATZ/);
	assert.strictEqual(fixed.window.sessionStorage.getItem("bokuRegistratorTask"), null);
	fixed.window.close();

	const waiting = await load(SA9, resultPage("WARTELISTE"), task({ phase: "submitted" }));
	assert.match(status(waiting.window), /Not a fixed place/);
	waiting.window.close();
});

const changeButton = (name) =>
	`<button id="btn0003" onclick="studUmmelden(false,'${name}','LV','Studium','elid3',100002,${GROUP},'',false,'100001');return false;">Ummelden</button>`;

// Adds the site's studUmmelden, which fills the same dialog with csave=U
const changePage = ({ warning = "", note = "" } = {}) =>
	selectionPage({ button: changeButton("Group 3") })
		.replace("</table>", `<tr><td>${note}</td></tr></table>`)
		.replace(
			"</script>",
			`function studUmmelden(fix, name, lv, st, id, abNr, grp) {
				opened++;
				document.getElementById("CONFIRM_DIV_MESSAGE").innerHTML = "Wollen Sie sich wirklich UMmelden?${warning}";
				document.getElementById("CONFIRM_DIV_LV_GRP").innerHTML = name;
				var f = document.forms[0].elements; f.cgrpnr.value = grp; f.csave.value = "U";
			}</script>`
		);

test("Ummelden is preselected on a group change page", async () => {
	const { window } = await load(SA2, changePage());
	assert.strictEqual(window.document.getElementById("boku-reg-mode").value, "change");
	window.close();
});

test("Ummelden submits the switch to the right group", async () => {
	const { window } = await load(SA2, changePage(), task({ mode: "change" }));
	await sleep(20);
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "U" }]);
	window.close();
});

test("Anmelden mode ignores an Ummelden button", async () => {
	const { window } = await load(SA2, changePage(), task({ opens: Date.now() - 1000 }), [changePage()]);
	await sleep(20);
	assert.strictEqual(window.opened, 0);
	window.close();
});

test("Ummelden refuses a waiting-list-only group", async () => {
	const { window } = await load(SA2, changePage({ note: "Anmeldung erfolgt nur auf Warteliste" }), task({ mode: "change" }));
	await sleep(20);
	assert.strictEqual(window.opened, 0);
	assert.deepStrictEqual(window.submits, []);
	window.close();
});

test("Ummelden stops when the dialog warns of a waiting list", async () => {
	const { window } = await load(SA2, changePage({ warning: " ACHTUNG: Warteliste" }), task({ mode: "change" }));
	await sleep(20);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /waiting list/);
	window.close();
});

test("result page reports a completed switch", async () => {
	const { window } = await load(SA9, resultPage("FIXPLATZ"), task({ mode: "change", phase: "submitted" }));
	assert.match(status(window), /Switched to Group 3: FIXPLATZ/);
	window.close();
});

test("Ummelden submits directly with the signup number from the fresh page", async () => {
	const closed = selectionPage();
	const { window } = await load(SA2, closed, task({ mode: "change" }), [closed, changePage()]);
	await sleep(100);
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "U" }]);
	assert.strictEqual(window.lastSignupId, "100002");
	window.close();
});

test("Ummelden refuses a waiting-list group on the fast path", async () => {
	const closed = selectionPage();
	const full = changePage({ note: "Anmeldung erfolgt nur auf Warteliste" });
	const { window } = await load(SA2, closed, task({ mode: "change" }), [closed, full]);
	await sleep(100);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /waiting list only/);
	window.close();
});

test("sends one early check, then the next request right at the opening", async () => {
	const closed = selectionPage();
	const open = selectionPage({ button: buttonHtml("Group 3") });
	const { window } = await load(SA2, closed, task({ opens: Date.now() + 500 }), [closed, open]);
	await sleep(250);
	assert.strictEqual(window.fetchCount, 1);
	assert.deepStrictEqual(window.submits, []);
	await sleep(500);
	assert.strictEqual(window.fetchCount, 2);
	assert.strictEqual(window.submits.length, 1);
	window.close();
});

test("does not submit before the set time even if the group is already open", async () => {
	const open = selectionPage({ button: buttonHtml("Group 3") });
	const { window } = await load(SA2, selectionPage(), task({ opens: Date.now() + 500 }), [open]);
	await sleep(250);
	assert.deepStrictEqual(window.submits, []);
	await sleep(500);
	assert.strictEqual(window.submits.length, 1);
	window.close();
});

test("uses the server's clock for the opening request", async () => {
	const closed = selectionPage();
	const open = selectionPage({ button: buttonHtml("Group 3") });
	let pages = 0;
	const { window } = await load(SA2, closed, task({ opens: Date.now() + 5000 }), async (url, options = {}) => {
		if (options.method === "HEAD") {
			return { headers: { get: () => new Date(Date.now() + 3000).toUTCString() } };
		}
		pages++;
		return { ok: true, url: SA2, text: async () => (pages > 1 ? open : closed) };
	});
	await sleep(3700); // The local clock is still over a second from the opening
	assert.strictEqual(window.submits.length, 1);
	window.close();
});

test("the help button shows and hides the explanation", async () => {
	const { window } = await load(SA2, selectionPage({ button: buttonHtml("Group 3") }));
	const help = window.document.getElementById("boku-reg-help");
	assert.strictEqual(help.hidden, true);
	window.document.getElementById("boku-reg-help-toggle").click();
	assert.strictEqual(help.hidden, false);
	assert.match(help.textContent, /Gruppenauswahl/);
	window.document.getElementById("boku-reg-help-toggle").click();
	assert.strictEqual(help.hidden, true);
	window.close();
});

const statusPage = (status = "WARTELISTE (15)") => `<body><table>
	<tr><td>Group 2</td><td>${status}</td><td>12.10.2026</td><td>UH 000 000 Bachelor</td><td>[VK] Mikrobiologie Übungen [Ist innerhalb der STEOP vorziehbar]</td></tr>
	<tr><td><a href="sa3.detailLVGrp?pLVGrpNr=111&pOrgNr=1">Group 2</a></td><td></td><td>12.10.26,09:00</td></tr>
	<tr><td><a href="sa3.detailLVGrp?pLVGrpNr=${GROUP}&pOrgNr=1">Group 3</a></td><td></td><td>03.11.40,09:00</td></tr>
</table></body>`;

const contextPage = (extra = "") => `<body><select name="s"><option value="100001" selected>UH 000 000 Bachelor</option></select><table>
	<tr><td><input type="radio" name="pCurriculumContext" value="CTX=="></td><td>Mikrobiologie Übungen</td></tr>
	<tr><td><input type="radio" name="pCurriculumContext" value="FREE"></td><td>Freie Anmeldung</td></tr>${extra}
</table></body>`;

const SA9_PERSON = `${SA9}&pStPersonNr=5`;
const statusTask = (extra = {}) =>
	task({ fromStatus: true, person: "5", mode: "change", context: "Mikrobiologie Übungen", study: "UH 000 000 Bachelor", url: "sa2.auswahl?first", ...extra });

// Serves pages by URL: the Ummelden link stays on the status page until `opened` is set
const statusServer = (state, pages) => async (url) => {
	state.urls.push(String(url));
	if (!state.opened) return { ok: true, url: SA9_PERSON, text: async () => statusPage() };
	const isGroupPage = String(url).includes("pPotentialContext");
	return { ok: true, url: SA2, text: async () => (isGroupPage ? pages.group : pages.context) };
};

test("the status page offers Ummelden for the next group and its opening time", async () => {
	const { window } = await load(SA9_PERSON, statusPage());
	assert.strictEqual(window.document.getElementById("boku-reg-mode").value, "change");
	assert.strictEqual(window.document.getElementById("boku-reg-group").value, String(GROUP));
	assert.strictEqual(window.document.getElementById("boku-reg-time").value, "2040-11-03T09:00");
	window.close();
});

test("arming on the status page stores the study context and the Ummelden link", async () => {
	const { window } = await load(SA9_PERSON, statusPage());
	window.document.getElementById("boku-reg-arm").click();
	const stored = JSON.parse(window.sessionStorage.getItem("bokuRegistratorTask"));
	assert.strictEqual(stored.context, "Mikrobiologie Übungen");
	assert.strictEqual(stored.fromStatus, true);
	assert.match(stored.url, /csave=P/);
	window.close();
});

test("an armed status page survives a reload and keeps checking", async () => {
	const state = { urls: [], opened: false };
	const { window } = await load(SA9_PERSON, statusPage(), statusTask(), statusServer(state, {}));
	await sleep(100);
	assert.ok(state.urls.length > 1);
	assert.ok(window.document.getElementById("boku-reg-cancel"));
	window.close();
});

test("after the opening it follows the link, picks the context and submits the switch", async () => {
	const state = { urls: [], opened: false };
	const pages = { context: contextPage(), group: changePage() };
	const { window } = await load(SA9_PERSON, statusPage(), statusTask(), statusServer(state, pages));
	await sleep(50);
	assert.deepStrictEqual(window.submits, []);
	state.opened = true;
	await sleep(100);
	assert.ok(state.urls.at(-1).includes("pStStudiumNr=100001"));
	assert.ok(state.urls.at(-1).includes(`pPotentialContext=${encodeURIComponent("CTX==")}`));
	assert.deepStrictEqual(window.submits, [{ cgrpnr: String(GROUP), csave: "U" }]);
	window.close();
});

test("stops when the study context doesn't match", async () => {
	const state = { urls: [], opened: true };
	const pages = { context: contextPage(), group: changePage() };
	const { window } = await load(SA9_PERSON, statusPage(), statusTask({ context: "Something Else" }), statusServer(state, pages));
	await sleep(50);
	assert.deepStrictEqual(window.submits, []);
	assert.match(status(window), /study context/);
	window.close();
});

test("gives up when Ummelden never becomes available", async () => {
	const state = { urls: [], opened: false };
	const { window } = await load(SA9_PERSON, statusPage(), statusTask({ opens: Date.now() - 6 * 60 * 1000 }), statusServer(state, {}));
	await sleep(50);
	assert.match(status(window), /Ummelden never became available/);
	window.close();
});
