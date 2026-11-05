# Hasanify

A Manifest V3 browser extension that autofills job applications — Workday, Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS and most home-grown ATS forms — from a profile you keep locally.

## Features

- **One-click autofill** from the toolbar popup, the floating on-page assistant, the right-click menu, or `Alt+Shift+F`.
- **Heuristic field matching**: reads `name`/`id`/`autocomplete`/`aria-*`/placeholder, `<label>`s, nearby text and section context (Education vs. Experience, "Work Experience 2") to classify ~60 field types.
- **Framework-safe injection**: native value setters plus `input`/`change`/`blur` events, real click sequences for radios, checkboxes and custom dropdowns (react-select, Workday listboxes), `DataTransfer` file uploads.
- **Multi-step forms**: a `MutationObserver` fills new steps as they render, and fields wiped by late React hydration are re-filled.
- **On-page assistant**: progress, filled count, a clickable "needs your attention" list, and an Attachments card for resume / cover-letter uploads.
- **Quick access side panel** (`Alt+Shift+C`, the popup, or the tab under the on-page launcher): a Chrome side panel docked next to the page with a daily applications counter, one-click autofill, *Save application* / *Mark as applied*, autofill settings, and your whole profile — click any value to copy it, or click into a form field first and hit **Insert** to type it straight in (React inputs, selects, searchable dropdowns, even inside iframes).
- **Multi-page applications**: once you fill one page, later pages of the same application in that tab fill automatically — full page loads, class-toggled steps, React/Vue steps that reuse inputs, busy pages that never stop re-rendering, and applications that continue on another domain (e.g. careers.acme.com → acme.icims.com, followed for 20 min after the last fill when the page looks like an application).
- **Tailored applications**: resume uploads can be *automatic*, *ask me each time* (pick saved or a tailored file from the assistant), or *manual*; cover letters can be left entirely to you.
- **AI profile builder**: copy a prompt into ChatGPT / Claude / Gemini with your resumes and questionnaires; it interviews you about anything missing and returns a profile you paste back and import.
- **Understands what a question means**: "Were you formerly employed by Acme?" reuses your answer to "Have you previously worked for {company}?" — related words (worked/employed, permitted/authorized, relocate/move…) are compared as concepts, not spelling.
- **Smart option picking**: "Years of experience" is computed from your work history and matched to ranges like "3–5 years", "5+", "Less than 2"; "B.S." matches "Bachelor's degree", "MSc" matches "Master's degree".
- **Answers that fit the job**: learned answers keep variants per context — senior vs junior, remote vs on-site, country — and per site, so salary or notice-period answers follow the role, and each site gets what you used there last time.
- **Site memory**: sites that re-render late are remembered; next time Hasanify waits longer and keeps re-checking so the form fills fully on the first try.
- **Confidence**: fields Hasanify wasn't sure about (calculated ranges, closest option, similar question, AI) get an amber "check this" outline and are listed in the assistant with what was filled and a **Looks right** button.
- **Check before submit**: clicking the final *Submit* holds the submit if a required field is empty, a "check this" field wasn't looked at, or an answer / attached file names a different company (a reused cover letter that still says "Globex") — fix it or **Submit anyway**.
- **AI assist (optional, your own key)**: Claude, OpenAI, Gemini or any OpenAI-compatible endpoint (Ollama, LM Studio…) resolves questions and dropdowns the rules can't, strictly from your profile; choices must be real options, low-confidence answers are dropped, results are cached, and the key never reaches web pages.
- **Profile dashboard**: personal info, links, experience, education, skills, work authorization, preferences, voluntary EEO answers, documents and custom Q&A — autosaved and validated against a JSON schema.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. The dashboard opens — fill your profile manually or with the **AI profile builder**.

## Project layout

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: storage, messaging, fill triggers, badge |
| `content.js` | Field scanning, classification, injection, mutation handling |
| `ui/widget.js` | Floating on-page assistant (closed shadow root) |
| `shared/profile-schema.js` | Profile JSON Schema, defaults, validator, completeness |
| `shared/ai.js` | Optional AI assist client (background only; Claude / OpenAI / Gemini / OpenAI-compatible) |
| `options/` | Profile dashboard + AI profile builder |
| `sidepanel/` | Quick access side panel (counter, autofill, save application, click-to-copy profile) |
| `popup/` | Toolbar popup |
| `ui/theme.css`, `ui/icons.js`, `icons/` | Shared styles, icons, extension icons |

## Privacy

Your profile and resume are stored only in `chrome.storage.local` on your machine. Hasanify never submits applications — always review before you click submit.

AI assist is off by default. When you turn it on, only the questions Hasanify could not answer (with their options) and your profile — without your resume, cover letter or diversity answers — are sent to the provider you chose, using your own API key.
