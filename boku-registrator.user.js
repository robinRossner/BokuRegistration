// ==UserScript==
// @name         BOKU Lightning Registrator
// @description  Registers for, or switches to, a BOKUonline course group as soon as it opens.
// @author       robinRossner
// @version      0.6.0
// @match        https://online.boku.ac.at/BOKUonline/sa2.auswahl*
// @match        https://online.boku.ac.at/BOKUonline/SA2.auswahl*
// @match        https://online.boku.ac.at/BOKUonline/sa9.lvAnmeldInfoSeite*
// @match        https://online.boku.ac.at/BOKUonline/SA9.lvAnmeldInfoSeite*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Flow: BOKU allows opening the group page only once every 5 seconds, so polling fast only leads
// to its wait page. Instead the script reads the opening time from the page, syncs to the server's
// clock and sends one background request right at the opening, then one per allowed interval.
// If a page shows the group's countdown (vGrpAnmeldToGo), it submits when that ends. The form from
// the response is submitted without a page load. Anything unusual (extra fields, test run) falls
// back to loading the page and using the site's own button and dialog, which keeps its checks.
// Before a group opens, BOKU sends the Ummelden link back to the status page, so a task can also
// be armed there. At the opening it follows the link, picks the same study context and continues.

(() => {
	"use strict";

	const KEY = "bokuRegistratorTask"; // sessionStorage: one task per tab, survives page loads
	const LEAD_MS = 60 * 1000; // Start checking this long before the opening time
	const MIN_REQUEST_MS = 5200; // BOKU allows one page request per 5 seconds
	const OPENING_MARGIN_MS = 50; // Send the opening request this long after the estimated opening
	const CLOCK_URL = "/BOKUonline/ee/theme/ca2/scripts/conx-custom-scripts.js"; // Static file, not rate limited
	const CLOCK_SAMPLES = 5;
	const CLOCK_SAMPLE_GAP_MS = 230; // Spread over a second to narrow down the 1 second Date header
	const MIN_SYNC_LEAD_MS = 3000; // Too close to the opening to spend time on syncing
	const COUNTDOWN_CHECK_MS = 20; // How often to check the site's countdown on a loaded page
	const GIVE_UP_MS = 5 * 60 * 1000; // Stop polling this long after the opening time
	const KEEPALIVE_MS = 10 * 60 * 1000; // Background fetch interval, keeps the login alive
	const MAX_MISSES = 3; // Polls without the course's groups before assuming the login expired

	const params = new URLSearchParams(location.search);
	const isResultPage = /sa9\.lvAnmeldInfoSeite/i.test(location.pathname);
	const courseId = params.get(isResultPage ? "pStpSpNr" : "clvnr");

	const loadTask = () => {
		try {
			return JSON.parse(sessionStorage.getItem(KEY));
		} catch {
			return null;
		}
	};
	const saveTask = (task) => sessionStorage.setItem(KEY, JSON.stringify(task));
	const clearTask = () => sessionStorage.removeItem(KEY);

	const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
	const pad = (n) => String(n).padStart(2, "0");

	const MODES = { register: "studAnmelden", change: "studUmmelden" };

	// The group number is an argument of the button's studAnmelden(...) or studUmmelden(...) call
	const findButton = (doc, group, mode) =>
		[...doc.querySelectorAll(`button[onclick*="${MODES[mode]}"]`)].find((button) =>
			new RegExp(`,\\s*${group}\\s*,`).test(button.getAttribute("onclick"))
		);

	// Reads the arguments the site's button would use, or null if the button needs the slow path
	const readButton = (button, mode) => {
		const onclick = button.getAttribute("onclick");
		const match =
			mode === "change"
				? onclick.match(/^studUmmelden\((true|false),'([^']*)',.*,(\d+),(\d+),'',false,'(\d+)'\);return false;$/s)
				: onclick.match(/^studAnmelden\('([^']*)',.*,(\d+),'',false,'(\d+)',false,false\);return false;$/s);
		if (!match) return null;
		return mode === "change"
			? { waitingList: match[1] === "true", name: match[2], signupId: match[3], group: match[4] }
			: { waitingList: false, name: match[1], signupId: "", group: match[2] };
	};

	// The server writes "vGrpAnmeldToGo[100000] = -1;" into the page, in seconds until opening
	const secondsToGo = (html, group) => {
		const match = html.match(new RegExp(`vGrpAnmeldToGo\\[${group}\\]\\s*=\\s*(-?\\d+)`));
		return match ? Number(match[1]) : 0;
	};

	const isWaitingListOnly = (button) => clean(button.closest("tr")?.nextElementSibling?.textContent).includes("Warteliste");

	const groupLinks = (doc) => [...doc.querySelectorAll('a[href*="detailLVGrp"][href*="pLVGrpNr="]')];

	// Reads "08.07.26,00:00" from the group's row as a value for a datetime-local input
	const openingTime = (link) => {
		const match = clean(link.closest("tr")?.innerText || link.closest("tr")?.textContent).match(
			/(\d\d)\.(\d\d)\.(\d\d),\s*(\d\d:\d\d)/
		);
		return match ? `20${match[3]}-${match[2]}-${match[1]}T${match[4]}` : "";
	};

	// The status table's row for the group you're in, or undefined when you aren't registered
	const currentSignup = () =>
		[...document.querySelectorAll("tr")].find((tr) => {
			const name = clean(tr.cells?.[0]?.textContent);
			return groupLinks(document).some((link) => clean(link.textContent) === name) && /^(FIXPLATZ|WARTELISTE)/.test(clean(tr.cells?.[1]?.textContent));
		});

	// Takes the context name without tags like "[VK]" and "[Ist innerhalb der STEOP vorziehbar]"
	const contextName = (row) => clean((row?.cells?.[4]?.textContent || "").replace(/\[[^\]]*\]/g, " "));

	// Builds the group page's URL from the study context page, as the Weiter button does
	const pickContext = (task, page) => {
		const options = [...page.querySelectorAll('input[name="pCurriculumContext"]')].map((radio) => ({
			value: radio.value,
			label: clean(radio.closest("tr")?.textContent)
		}));
		const matches = task.context
			? options.filter((option) => option.label.includes(task.context))
			: options.filter((option) => !option.label.includes("Freie Anmeldung"));
		const studies = [...page.querySelectorAll("select option")].filter((option) => /^\d+$/.test(option.value));
		const study = studies.length === 1 ? studies[0] : studies.find((option) => task.study && clean(option.textContent) === task.study);
		if (matches.length !== 1 || !study) return null;
		return `sa2.auswahl?cst_person_nr=${task.person}&clvnr=${task.courseId}&pStStudiumNr=${study.value}&copener=&csave=P&pStpKnotenSelected=J&pPotentialContext=${encodeURIComponent(matches[0].value)}`;
	};

	const getGroups = () =>
		groupLinks(document).map((link) => ({
			number: link.href.match(/pLVGrpNr=(\d+)/)[1],
			name: clean(link.textContent),
			opens: openingTime(link)
		}));

	// --- Panel ---

	const STYLE = `
		#boku-reg { position: fixed; right: 12px; top: 80px; z-index: 99999; width: 280px; max-height: calc(100vh - 92px); overflow-y: auto;
			background: #fff; color: #222; border-radius: 8px; box-shadow: 0 4px 18px rgba(0, 0, 0, .25);
			font: 14px/1.4 "Open Sans", Arial, sans-serif; }
		#boku-reg * { box-sizing: border-box; font-family: inherit; }
		#boku-reg .br-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #00aa5a; color: #fff; }
		#boku-reg .br-title { flex: 1; font-size: 15px; font-weight: 700; }
		#boku-reg .br-help-toggle { width: 24px; height: 24px; padding: 0; border: 1px solid #fff; border-radius: 50%;
			background: transparent; color: #fff; font-weight: 700; line-height: 1; cursor: pointer; }
		#boku-reg .br-help-toggle[aria-expanded="true"] { background: #fff; color: #00803f; }
		#boku-reg .br-help { max-height: 50vh; overflow-y: auto; padding: 10px 12px; background: #eefaf3;
			border-bottom: 1px solid #cdebd9; font-size: 13px; }
		#boku-reg .br-help ol { margin: 0 0 8px; padding-left: 18px; }
		#boku-reg .br-help li { margin-bottom: 5px; }
		#boku-reg .br-help p { margin: 0 0 5px; }
		#boku-reg .br-body { padding: 12px; }
		#boku-reg label.br-field { display: block; margin-bottom: 9px; color: #555; font-size: 12px; font-weight: 600; }
		#boku-reg select, #boku-reg input[type="datetime-local"] { display: block; width: 100%; height: 34px; margin-top: 3px; padding: 0 8px;
			border: 1px solid #bbb; border-radius: 6px; background: #fff; color: #222; font-size: 14px; font-weight: 400; }
		#boku-reg select:focus, #boku-reg input:focus { border-color: #00aa5a; outline: 2px solid rgba(0, 170, 90, .25); }
		#boku-reg label.br-check { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 13px; cursor: pointer; }
		#boku-reg .br-main { width: 100%; height: 38px; border: 0; border-radius: 6px; background: #00aa5a; color: #fff;
			font-size: 14px; font-weight: 700; cursor: pointer; }
		#boku-reg .br-main:hover { background: #00964f; }
		#boku-reg .br-main.br-cancel { background: #eee; color: #333; }
		#boku-reg .br-main.br-cancel:hover { background: #e0e0e0; }
		#boku-reg .br-summary { margin-bottom: 8px; font-weight: 600; }
		#boku-reg .br-countdown { margin-bottom: 10px; color: #00803f; font-size: 26px; font-weight: 700; text-align: center; }
		#boku-reg .br-countdown:empty { display: none; }
		#boku-reg-status { margin-top: 10px; padding: 8px 10px; border-left: 4px solid currentColor; border-radius: 4px;
			background: #f5f5f5; font-size: 13px; font-weight: 600; }
		#boku-reg-status:empty { display: none; }
	`;

	const element = (tag, properties = {}, ...children) => {
		const node = Object.assign(document.createElement(tag), properties);
		node.append(...children);
		return node;
	};

	const panel = element("div", { id: "boku-reg" });
	const statusLine = element("div", { id: "boku-reg-status" });
	const countdownLine = element("div", { id: "boku-reg-countdown", className: "br-countdown" });

	const setStatus = (text, color = "#222") => {
		statusLine.textContent = text;
		statusLine.style.color = color;
	};

	const finish = (text, color) => {
		clearTask();
		clearInterval(countdownTimer);
		countdownLine.textContent = "";
		setStatus(text, color);
		document.title = `[${text.slice(0, 30)}] ${document.title}`;
		console.log("[BOKU Registrator]", text);
		const cancel = document.getElementById("boku-reg-cancel");
		if (cancel) cancel.remove();
	};

	const buildHelp = () =>
		element(
			"div",
			{ id: "boku-reg-help", className: "br-help", hidden: true },
			element(
				"ol",
				{},
				element("li", { textContent: 'Open the course\'s group page ("Gruppenauswahl") or its status page. If Ummelden isn\'t available yet, stay on the status page and arm from there.' }),
				element("li", { textContent: "Choose Anmelden or Ummelden and pick the group. The opening time is filled in from the page, so check it's right." }),
				element("li", { textContent: "Click Arm. Keep this tab open and visible, your computer awake and yourself logged in." }),
				element("li", { textContent: "At the opening it signs you up by itself and shows the result here. FIXPLATZ means you have a fixed place." })
			),
			element("p", { textContent: "Don't reload the page while armed. BOKU allows one page load per 5 seconds and shows a wait page otherwise." }),
			element("p", { textContent: "From the status page, it uses the study context of your current group. Use one tab per course." }),
			element("p", { textContent: "Test run stops at the confirmation dialog, on a course that's already open, so nothing is submitted." }),
			element("p", { textContent: "It stops and leaves the rest to you if BOKU asks for anything extra. It won't switch you to a waiting-list group." })
		);

	const help = buildHelp();
	const helpToggle = element("button", { type: "button", id: "boku-reg-help-toggle", className: "br-help-toggle", textContent: "?", title: "How it works" });
	helpToggle.setAttribute("aria-expanded", "false");
	helpToggle.onclick = () => {
		help.hidden = !help.hidden;
		helpToggle.setAttribute("aria-expanded", String(!help.hidden));
	};

	const showPanel = (...children) => {
		if (!document.getElementById("boku-reg-style")) {
			document.head.append(element("style", { id: "boku-reg-style", textContent: STYLE }));
		}
		const head = element("div", { className: "br-head" }, element("div", { className: "br-title", textContent: "⚡ BOKU Registrator" }), helpToggle);
		const body = element("div", { className: "br-body" }, ...children, statusLine);
		panel.replaceChildren(head, help, body);
		if (!panel.isConnected) document.body.append(panel);
	};

	const field = (text, control) => element("label", { className: "br-field" }, text, control);

	const showSetup = () => {
		const groups = getGroups();
		if (!groups.length) return;

		const mode = element("select", { id: "boku-reg-mode" });
		mode.add(new Option("Anmelden (sign up)", "register"));
		mode.add(new Option("Ummelden (switch group)", "change"));
		const signup = isResultPage ? currentSignup() : null;
		if (signup || document.querySelector(`button[onclick*="${MODES.change}"]`)) mode.value = "change";

		const select = element("select", { id: "boku-reg-group" });
		for (const group of groups) select.add(new Option(group.name, group.number));

		// Preselect the next group to open, which is what a status page is armed for
		const upcoming = groups.findIndex((group) => new Date(group.opens).getTime() > Date.now());
		if (isResultPage && upcoming >= 0) select.selectedIndex = upcoming;
		const time = element("input", { id: "boku-reg-time", type: "datetime-local", step: 1, value: groups[select.selectedIndex].opens });
		select.onchange = () => (time.value = groups[select.selectedIndex].opens);

		const dry = element("input", { id: "boku-reg-dry", type: "checkbox" });
		const dryLabel = element("label", { className: "br-check" }, dry, "Test run (stop before OK)");

		const arm = element("button", { id: "boku-reg-arm", type: "button", className: "br-main", textContent: "Arm" });
		arm.onclick = () => {
			const opens = new Date(time.value).getTime();
			if (!opens) return setStatus("Pick the opening time first.", "#b71c1c");
			const hasButtons = (kind) => document.querySelector(`button[onclick*="${MODES[kind]}"]`);
			const other = mode.value === "change" ? "register" : "change";
			if (hasButtons(other) && !hasButtons(mode.value)) {
				return setStatus(`This page only offers ${mode.options[mode.selectedIndex === 0 ? 1 : 0].text}.`, "#b71c1c");
			}
			const group = groups[select.selectedIndex];
			if (isResultPage && mode.value === "change" && !contextName(signup)) {
				return setStatus("Ummelden needs an existing signup with a study context.", "#b71c1c");
			}
			const person = params.get("pStPersonNr");
			const task = {
				courseId,
				url: isResultPage
					? `sa2.auswahl?cst_person_nr=${person}&clvnr=${courseId}&pStStudiumNr=&copener=&csave=P&cststudnr=`
					: location.href,
				fromStatus: isResultPage,
				person,
				context: isResultPage ? contextName(signup) : "",
				study: isResultPage ? clean(signup?.cells?.[3]?.textContent) : "",
				group: group.number,
				name: group.name,
				mode: mode.value,
				opens,
				dry: dry.checked,
				phase: "armed"
			};
			saveTask(task);
			showArmed(task);
			run(task);
		};

		showPanel(field("Action", mode), field("Group", select), field("Opens at", time), dryLabel, arm);
	};

	const showArmed = (task) => {
		const when = new Date(task.opens);
		const summary = element("div", {
			className: "br-summary",
			textContent:
				`${task.mode === "change" ? "Ummelden to" : "Anmelden to"} ${task.name}, ${pad(when.getDate())}.${pad(when.getMonth() + 1)}. ${pad(when.getHours())}:${pad(when.getMinutes())}` +
				(task.dry ? " (test run)" : "")
		});
		const cancel = element("button", { id: "boku-reg-cancel", type: "button", className: "br-main br-cancel", textContent: "Cancel" });
		cancel.onclick = () => {
			clearTimeout(timer);
			clearInterval(countdownTimer);
			clearTask();
			location.assign(task.url);
		};
		const tick = () => {
			const left = Math.ceil((task.opens - serverOffset - Date.now()) / 1000);
			const hours = Math.floor(left / 3600);
			countdownLine.textContent =
				left > 0 ? `${hours ? `${hours}:` : ""}${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}` : "";
		};
		tick();
		clearInterval(countdownTimer);
		countdownTimer = setInterval(tick, 1000);
		showPanel(summary, countdownLine, cancel);
	};

	// --- Registration ---

	let timer;
	let countdownTimer;
	let serverOffset = 0; // Estimated server clock minus local clock, in ms
	let clockSynced = false;
	let checkedEarly = false;
	let lastKeepAlive = Date.now();
	let misses = 0;
	let lastRequest = Date.now(); // Loading this page counted as a request

	const countdownDone = (group) => {
		const toGo = window.vGrpAnmeldToGo?.[group];
		return typeof toGo !== "number" || window.vCountUp >= toGo;
	};

	const register = (task, button) => {
		// A switch to a waiting list could cost the fixed place you already have
		if (task.mode === "change" && isWaitingListOnly(button)) {
			return finish(`${task.name} is waiting list only. Not switching.`, "#b71c1c");
		}

		const message = document.getElementById("CONFIRM_DIV_MESSAGE");
		if (!message) return finish("Confirmation dialog not found. Register by hand.", "#b71c1c");

		// The site only fills this message in when it opens the normal confirmation dialog
		message.innerHTML = "";
		button.click();
		if (!clean(message.textContent)) {
			return finish("The site asked for something else. Finish by hand.", "#b71c1c");
		}

		const shownGroup = clean(document.getElementById("CONFIRM_DIV_LV_GRP")?.textContent);
		if (shownGroup !== task.name) {
			return finish(`Dialog shows "${shownGroup}", not "${task.name}". Stopped.`, "#b71c1c");
		}
		if (task.mode === "change" && /Warteliste/i.test(message.textContent)) {
			return finish("The site warns of a waiting list. Not switching.", "#b71c1c");
		}
		if (task.dry) return finish("Test run OK: dialog is open, OK not clicked.", "#2e7d32");

		let box = message;
		while (box && !box.querySelector("button")) box = box.parentElement;
		const ok = box && [...box.querySelectorAll("button")].find((b) => clean(b.textContent) === "OK");
		if (!ok) return finish("OK button not found. Finish by hand.", "#b71c1c");

		saveTask({ ...task, phase: "submitted" });
		setStatus("Submitting...");
		ok.click();
	};

	// Submits the form from a fetched page, setting the same fields as the site's button and OK.
	// The form has to come from the fresh response because the site changes pDesiredContextId per page.
	const submitFetched = (task, page, details) => {
		const form = document.adoptNode(page.forms[0]);
		const fields = {
			cgrpnr: task.group,
			cabgrppersnr: details.signupId,
			csave: task.mode === "change" ? "U" : "J",
			pLVGrpProfNr: "",
			pPHOrgNr: "",
			pPHOrgName: "",
			pPHOrgKennung: ""
		};
		for (const [name, value] of Object.entries(fields)) form.elements[name].value = value;
		form.style.display = "none";
		document.body.append(form);
		saveTask({ ...task, phase: "submitted" });
		setStatus("Submitting...");
		HTMLFormElement.prototype.submit.call(form);
	};

	// The Date header only has whole seconds, so each response bounds the server clock. Using the
	// lower bound means the server has reached the opening time once the request is sent.
	const syncClock = async () => {
		let lowest = -Infinity;
		for (let i = 0; i < CLOCK_SAMPLES; i++) {
			const response = await fetch(CLOCK_URL, { method: "HEAD", cache: "no-store", credentials: "omit" });
			const received = Date.now();
			const date = Date.parse(response.headers.get("date"));
			if (date) lowest = Math.max(lowest, date - received);
			if (i < CLOCK_SAMPLES - 1) await new Promise((resolve) => setTimeout(resolve, CLOCK_SAMPLE_GAP_MS));
		}
		if (lowest > -Infinity) serverOffset = lowest;
	};

	const openingAt = (task) => task.opens - serverOffset + OPENING_MARGIN_MS;

	// Loads the real page once BOKU's request limit allows it
	const loadPageLater = (task) => {
		timer = setTimeout(() => location.assign(task.url), Math.max(0, lastRequest + MIN_REQUEST_MS - Date.now()));
	};

	const fetchPage = async (url) => {
		lastRequest = Date.now();
		const response = await fetch(url, { credentials: "same-origin" });
		if (!response.ok || /sa3\.waitpage/i.test(response.url)) return null;
		const html = await response.text();
		return { html, page: new DOMParser().parseFromString(html, "text/html"), onStatusPage: /sa9\.lvAnmeldInfoSeite/i.test(response.url) };
	};

	// Returns true if checking should go on
	const poll = async (task) => {
		let result = await fetchPage(task.url);
		if (!result) return true;

		if (result.page.querySelector('input[name="pCurriculumContext"]')) {
			const url = pickContext(task, result.page);
			if (!url) {
				finish("Couldn't match your study context. Finish by hand.", "#b71c1c");
				return false;
			}
			task.url = url;
			saveTask(task);
			result = await fetchPage(url);
			if (!result) return true;
		}

		if (result.onStatusPage) {
			if (task.fromStatus) return true; // BOKU sends the link back here until the group opens
			location.assign(task.url); // Already registered: show the status page
			return false;
		}

		const { html, page } = result;
		const button = findButton(page, task.group, task.mode);
		if (button) {
			const details = readButton(button, task.mode);
			const canSubmit = !task.dry && details && details.group === task.group && details.name === task.name && page.forms[0];
			if (!canSubmit) {
				loadPageLater(task); // Use the site's own button and dialog
				return false;
			}
			if (task.mode === "change" && (details.waitingList || isWaitingListOnly(button))) {
				finish(`${task.name} is waiting list only. Not switching.`, "#b71c1c");
				return false;
			}
			const seconds = secondsToGo(html, task.group);
			if (seconds > 0) setStatus(`Opens in ${seconds} s. Submitting at that moment.`);
			const delay = Math.max(seconds * 1000, openingAt(task) - Date.now(), 0);
			timer = setTimeout(() => submitFetched(task, page, details), delay);
			return false;
		}

		misses = groupLinks(page).some((link) => link.href.includes(`pLVGrpNr=${task.group}`)) ? 0 : misses + 1;
		return misses < MAX_MISSES;
	};

	const run = async (task) => {
		let now = Date.now();
		const button = findButton(document, task.group, task.mode);

		if (button && now >= task.opens - LEAD_MS) {
			if (countdownDone(task.group) && now >= openingAt(task)) return register(task, button);
			setStatus("Ready. Signing up at the opening.");
			timer = setTimeout(() => run(task), COUNTDOWN_CHECK_MS);
			return;
		}
		if (now > task.opens + GIVE_UP_MS) return finish(`Gave up: ${task.mode === "change" ? "Ummelden" : "Anmelden"} never became available.`, "#b71c1c");

		if (now < task.opens - LEAD_MS) {
			setStatus("Armed. Keep this tab open and visible.");
			if (now - lastKeepAlive > KEEPALIVE_MS) {
				lastKeepAlive = now;
				lastRequest = now;
				fetch(task.url, { credentials: "same-origin" }).catch(() => {});
			}
			timer = setTimeout(() => run(task), 1000);
			return;
		}

		if (!clockSynced && openingAt(task) - now > MIN_SYNC_LEAD_MS) {
			clockSynced = true;
			try {
				await syncClock();
			} catch (error) {
				console.warn("[BOKU Registrator] Clock sync failed:", error);
			}
			now = Date.now();
		}

		// One early check in case the page already shows a countdown, then the next one at the opening
		const earliest = lastRequest + MIN_REQUEST_MS;
		const checkEarly = !checkedEarly && earliest + MIN_REQUEST_MS <= openingAt(task);
		const target = checkEarly ? earliest : Math.max(earliest, openingAt(task));
		if (target > now) {
			setStatus(now < openingAt(task) ? "Ready. Checking right at the opening." : "Waiting for BOKU's 5 second limit...");
			timer = setTimeout(() => run(task), target - now);
			return;
		}
		if (checkEarly) checkedEarly = true;

		setStatus("Checking for the opening...");
		let keepGoing = true;
		try {
			keepGoing = await poll(task);
		} catch (error) {
			console.warn("[BOKU Registrator] Check failed:", error);
		}
		if (misses >= MAX_MISSES) return finish("Login seems to have expired. Log in and arm again.", "#b71c1c");
		if (keepGoing) timer = setTimeout(() => run(task), 0);
	};

	// Reads the group's row in the "aktueller Status" table
	const readStatus = (task) => {
		const row = [...document.querySelectorAll("tr")].find((tr) => clean(tr.cells?.[0]?.textContent) === task.name);
		return clean(row?.cells?.[1]?.textContent);
	};

	// --- Start ---

	const task = loadTask();
	const ownTask = task && task.courseId === courseId ? task : null;

	if (isResultPage) {
		if (!ownTask) {
			showSetup();
			return;
		}
		if (ownTask.fromStatus && ownTask.phase === "armed") {
			showArmed(ownTask);
			run(ownTask);
			return;
		}
		showPanel();
		const status = readStatus(ownTask);
		if (ownTask.phase === "armed") finish(`Already registered${status ? `: ${status}` : ""}. Use the Ummelden page to switch.`, "#b71c1c");
		else if (status === "FIXPLATZ") finish(`${ownTask.mode === "change" ? "Switched to" : "Registered for"} ${ownTask.name}: FIXPLATZ`, "#2e7d32");
		else if (status) finish(`${ownTask.name}: ${status}. Not a fixed place, check this page.`, "#e65100");
		else finish("Registration not confirmed. Check this page.", "#b71c1c");
	} else if (ownTask?.phase === "submitted") {
		// Back on the selection page after submitting: never resubmit automatically
		showPanel();
		finish("Registration not confirmed. Check this page.", "#b71c1c");
	} else if (ownTask) {
		showArmed(ownTask);
		run(ownTask);
	} else {
		showSetup();
	}
})();
