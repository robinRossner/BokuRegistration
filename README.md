# BOKU Lightning Registrator

A Tampermonkey userscript that registers you for a BOKUonline course group, or switches you to another group, the moment
registration opens.

Popular groups fill within seconds of opening, and BOKU only lets you load the group page once every 5 seconds, so
mashing F5 doesn't work. This script waits for the opening time and sends the signup for you. Exams are not supported.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `boku-registrator.user.js`.

## Usage

1. Log in and open the course's group page ("LV-Anmeldung - Gruppenauswahl").
   To switch groups, go through **Ummelden** on your status page and pick the study context first. If Ummelden isn't
   available yet, arm from the status page instead. The script then follows the Ummelden link at the opening, using the
   study context of your current group, and stops if it can't match it exactly.
2. In the panel at the top right (the **?** button explains the steps), choose **Anmelden** or **Ummelden**, pick the
   group and check the opening time, which is prefilled from the page.
3. Optionally tick **Test run**. It goes through everything but stops at the confirmation dialog, so you can try it on a
   course that is already open.
4. Click **Arm**. Leave the tab open and visible and the computer awake, because browsers throttle background tabs.

The result shows in the panel and in the tab title. Only a `FIXPLATZ` result is reported as a fixed place.

## How it behaves

- It syncs to BOKU's server clock, then sends one background request at the opening time and another every 5.2 seconds
  until 5 minutes after it. It never reloads the page or polls faster than the limit.
- If the page already shows the group's countdown, it submits when the countdown ends.
- The signup is sent directly, without loading the group page first.
- It stops and leaves the rest to you if the site opens any other dialog (for example when a group needs extra fields),
  if the dialog names a different group, or if the login has expired. It never resubmits on its own.
- In Ummelden mode it refuses to switch to a waiting-list group, so you can't lose your current place.

## Tests

```bash
npm install
npm test
```

The tests use `node --test` with jsdom.

## Responsible use

The script only acts within your own logged-in session, respects the 5-second page limit and bypasses no access control.
Use it at your own risk and check your university's rules first.

## License

MIT, see [LICENSE](LICENSE).
