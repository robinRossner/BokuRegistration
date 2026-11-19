# BOKU Lightning Registrator

A userscript that registers you for a BOKUonline course group, or switches you to another group, as soon as it opens. Exams are not supported yet.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Create a new script in Tampermonkey and paste in `boku-registrator.user.js`.

## Use

1. Log in to BOKUonline and open the course's group page ("LV-Anmeldung - Gruppenauswahl").
   To switch groups, use **Ummelden** on your status page and pick the study context first, so you reach the page with the Ummelden buttons.
   If Ummelden isn't available yet because the group hasn't opened, arm from the status page instead. At the opening the script follows the Ummelden link in the background and uses the study context of your current group. If it can't match that context exactly, it stops.
2. In the panel at the top right (the **?** button explains the steps), choose **Anmelden** or **Ummelden**, pick the group and check the opening time. It is prefilled from the page.
3. Tick **Test run** to stop at the confirmation dialog without registering, if the course is already open.
4. Click **Arm** and leave the tab open and visible, with the computer awake. Browsers slow down background tabs.

BOKU only allows the group page to be opened once every 5 seconds and shows a wait page otherwise, so the script doesn't poll fast or reload the page. It syncs to BOKU's clock and sends one background request right at the opening time, then one every 5.2 seconds until 5 minutes after it. If the page already shows the group's countdown, it submits when that ends. Either way the signup goes out directly, without loading the page first. It tells you the result in the panel and the tab title. Only a `FIXPLATZ` result is reported as a fixed place.

It stops and leaves the rest to you if the site opens any other dialog (for example when a group needs extra fields), if the dialog names a different group, or if the login has expired. It never resubmits on its own. In Ummelden mode it also refuses to switch to a waiting-list group, so you don't risk your current place.

## Test

```bash
npm install
```

```bash
npm test
```

## Responsible use

This script acts only within your own logged-in session. It respects the site's rate limit (one page request per 5 seconds) and does not bypass any access control. Use it at your own risk, and check your university's rules before using it.

## License

MIT, see [LICENSE](LICENSE).
