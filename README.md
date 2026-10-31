# Historical Timeline 1.26.0

A historical timeline plugin for Obsidian. Keep events in the plugin or choose to create Markdown notes. Uses Obsidian's vault, properties, commands, navigation, themes, and Sync; no separate account, network requests, or runtime dependencies. Requires Obsidian 1.5.7 or newer.

## Start using it

Enable **Historical Timeline** under Settings → Community plugins. Click the history ribbon icon, or run **Historical Timeline: Open timeline** from the command palette. **Add event** opens an editor; **Timeline only (no new note)** is the default storage choice.

- **Chronicle:** chronological cards.
- **Timeline:** a vertical event list with details, historical perspectives, and connections.
- **Wall chart:** a continuous horizontal chart. Specific events stack in centered columns by year; periods span their start and end columns. Events are packed using their rendered text height, with a 12px gap between overlapping items. Short titles do not reserve full-height rows; wrapping and resizing trigger recalculation. Overlapping periods are ordered by date duration: longer periods outside, shorter periods nearer the axis. Non-overlapping periods can still share space. Year spacing emphasizes readability, not elapsed time. The chart extends through the current year automatically. Its compact viewport preserves text size and year-column widths; scroll horizontally and, for tall stacks, vertically to see all events.
- **Cause & Effect:** choose **Saved analyses** for broader historical arguments or **Timeline overview** for one combined fishbone of the selected timelines. The selected timelines form the head, each saved cause→effect pair gets its own diagonal branch, labelled with its category; diagrams preserve your explicit relationships without inventing indirect causes.

In **Timeline**, select an event in the left list, then use **↑ / ↓** to browse the filtered events; **Home / End** selects the first or last. On desktop, scrolling over the left list also steps through events, with a short rate limit for trackpads. The selected row stays visible within the list and its details update in place. Scrolling over the details or the rest of the page remains normal; mobile touch scrolling is unchanged. These selections also work with Obsidian’s Back/Forward navigation.

Hold a view tab for 400 ms, drag onto another tab, and release to reorder. A target indicator appears while dragging; tab positions change only on release. Escape cancels. Alt+Left/Right reorders a focused tab. Order is saved in plugin data.

On desktop, the small crosshair button in the Wall chart’s lower-right corner (**Recentre on time axis**) returns vertically to the year axis while keeping the same years in view. It stays in the corner as you scroll, with a neutral icon that uses the chart’s accent color on hover or keyboard focus. It also works when comparing timelines and in embedded charts.

Search and filter controls stick to the top while scrolling. **Hide filters** collapses them while leaving the view tabs visible. **Historical Timeline: Search timeline events** reveals hidden filters and focuses timeline search while the timeline view is active, preserving the current chart, selection, and scroll position. It has no default shortcut; assign one in Settings → Hotkeys. Existing system and Obsidian search shortcuts are left alone. Search ignores case by default; **Ignore case** toggles this preference. **Clear all filters** resets the filters and comparison. Combine active conditions with All, Any, or None (one flat group).

The **Timeline** filter allows multiple selections: open it and check, for example, **Germany** and **China**. Events belonging to either timeline appear together; a shared event appears once in chronological views. **All timelines** clears the selection. Use **Done**, Escape, or a click outside to close the list; arrow keys move between choices and Space toggles them. Selections survive view changes and Obsidian Back/Forward navigation. The selected timelines form one combined filter condition alongside category, tag, and search. Wall chart’s **Compare timelines** temporarily uses its separate Above/Below choices; turning comparison off restores the multi-selection.

**Exclude tags** hides events with any checked tag while keeping your timeline selection. For example, exclude `paper-1` when revising Paper 2; an event tagged with both `paper-1` and `paper-2` is hidden too. Matches are exact tag names: excluding `paper-1` does not exclude `paper-10`. Exclusions take priority over All/Any/None matching and remain active during Wall chart comparison. Choose **No excluded tags** to restore these events, or **Clear all filters** to reset every filter. Nothing is deleted. Exclusions are remembered with the view and Back/Forward history. Like the other event filters, they apply to Cause & Effect’s **Timeline overview**; saved analyses retain their authored contents. Explicitly following an event connection clears filters to reveal that event; saving a new event removes only exclusions that would hide it.

## Creating and editing

Timelines, categories, tags, locations, sources, and historian names suggest previously saved values as you type. Source suggestions include citations from events, connections, and historical perspectives. A complete match remains available. Press **Enter** in the input to choose the first suggestion, or use Down to browse. Up from the first or Down from the last suggestion returns to typing; Left/Right also returns to the input. Escape dismisses the list. Suggestions do not submit the form.

An event can belong to multiple timelines, one name per line. No default History timeline is assigned. Tags accept commas or spaces; leading # is optional, duplicate tags are removed, and tags are stored in lowercase. Importance highlights an event across the views.

The event title field shows case-insensitive suggestions for existing events and offers **Edit** to open one instead. **Historical perspectives** supports multiple historians, each with an interpretation and source/citation. All are optional.

Select **Unknown / not yet dated** for an event whose time is unknown. It remains editable through **Undated events** and can be connected to other events. It is excluded from the three chronological charts and automatic Timeline overview diagrams, but can be explicitly attached as evidence in a saved analysis. Dates can be added later. A normal note without timeline properties is not treated as an undated event.

## Connections

In event details, choose **Add cause** when the selected event is the result, or **Add consequence** when it is the cause. Both endpoints can be changed. The empty endpoint receives focus automatically with suggestions already visible. Type in either event field and press Enter directly for the first result; exact names rank first. Changing Ignore case immediately refreshes the current suggestions. The other endpoint is excluded to avoid accidental self-connections.

Choose **Create new event: …** to make an endpoint with only a title, or **Create abstract factor: …** for an outcome such as “Nationalism becomes increasingly dominant.” Abstract factors need no date or Markdown note; they can be either causes or effects and appear in Cause & Effect, but never in Chronicle, Timeline, or Wall chart. The regular editor also offers **Abstract factor / outcome (no date)** under Time type. This action remains available even when many saved events match your query. Its date is optional. New endpoints and their connection are saved together only when **Save connection** succeeds; cancelling creates nothing. Add further information later through the editor.

Connections display as contributing causes on the target and consequences on the source. **Edit connection** allows changing or removing the connection. Connections to undated events are accessible in details, but undated nodes do not appear on chronological charts or automatic Timeline overview diagrams. The automatic overview displays links only when both dated events or abstract factors pass the active filters, including links between different selected timelines, and omits events with no visible links; details can still show connections outside that filter.

Connections are stored in plugin data and support timeline-only and note-backed events. Note renames made while the plugin is running update connection references. Missing endpoints are identified in details. Relationships are entered by you; the plugin does not infer historical claims.

## Saved fishbone analyses

The default **Timeline overview** combines existing relationships automatically: for example, Japanese expansion is the head, Politics labels separate war→treaty branches, and Wall Street Crash → tariff has its own Economics branch. Repeated categories are intentional. Each branch uses a straight inward arrow; there are no curves between branches. Shared events repeat on the branches for their individual relationships. Cross-category pairs show both category names. Within each pair, the effect is positioned closer to the spine than its cause. Explicit arrows represent saved causal connections; faint structural lines only group categories. Unrelated events do not gain links merely by sharing a branch. Select any event to read its details. The Connections disclosure lists every exact cause, effect, relationship, explanation, and citation. Feedback cycles are marked, and each direction still has its own branch. If All timelines is selected, an Overview timeline picker chooses one connected timeline. **Customize this fishbone** opens a prefilled analysis with the current categories, events, and causal-arrow setting; saving it does not alter the underlying causal connections.

For a blank diagram, open **Cause & Effect → New analysis**. Name the **Outcome / question at the head**: this can be a major consequence, a question, or a specific event. Optionally attach an existing event to the head. No date is required for an analytical question.

Assign one or more timelines, add your own **branch headings**, then add factors beneath them. **Show saved causal arrows and order events toward the spine** keeps explicit relationships between attached events visible in the customized diagram. This is enabled automatically when customizing a Timeline overview. It remains optional for freeform historical arguments. Each factor can contain an argument, an optional supporting event, its role (background condition, trigger, enabling factor, contributing factor, or counterargument), an explanation, citation, historians’ perspectives, and a disputed flag. Existing branch headings, timeline names, and citations suggest saved values. Event pickers keep full matches and accept Enter directly.

Saved analyses and existing event connections are independent: attaching an event as evidence does not add, remove, or change its causal links. Select a factor to inspect its argument and attached event. **Explore earlier causal links** expands the actual saved chain, including undated events; cycles and very deep chains are bounded. Missing event references remain identified rather than silently deleting the argument.

The analysis editor shows compact branch headings with factor counts. Open a branch or factor to work on it; **Rename branch** reveals its heading input. **Attach head event**, **Attach branch outcome**, and **Attach supporting event** open an event search only when needed. Selecting evidence fills an empty factor title automatically; changing or cancelling an attachment search preserves the old reference until you select a replacement or explicitly clear it. Citations, historians’ perspectives, and the disputed flag live under **Sources & perspectives**, marked **Added** when populated. Adding and removing factors preserves nearby fields and scroll position; toggling causal arrows keeps the current editor and disclosure state intact.

Use **Add event** on a branch to place existing events directly along it. Search by title or alias across your event library, select an event, then search again to add another. Events already on that branch are excluded; the same event can still support another branch. For example, Russian Civil War and Munich Conference can both sit on **Mutual fear and aggression**. **Add factor** remains available for your own arguments. Save the analysis to keep these additions; cancelling the editor leaves the saved analysis unchanged.

The Timeline selector scopes analyses to any of the selected timelines. Event search/category/tag/importance filters apply to **Timeline overview**, not to the contents of a saved argument. Use **Edit analysis** to adjust the head, branches, or factors. Removing an analysis leaves dated events and connections intact; newly unreferenced abstract or undated records are handled by automatic cleanup. Analysis-only factors are not inserted into the event library or chronological charts.

Timeline event selection updates the details panel in place, preserving the left-hand list’s scroll position and keyboard focus.

## Dates

| Input | Meaning |
| --- | --- |
| `221 BCE` or `221 BC` | A BCE year |
| `1911` or `1911 CE` | A CE year |
| `1911-10` | A month |
| `1911-10-10` | A specific day |
| `0044-03-15 BCE` | A specific BCE day |
| `c. 500 BCE` | Approximate date |
| `1930s` | 1930–1939 CE |
| `40s BCE` | 49–40 BCE |
| `19th century` | 1801–1900 CE |
| `5th century BCE` | 500–401 BCE |

Choose **Specific time** for year, month, or day precision. Choose **Period / decade / century** for a range or a whole decade/century. Both date fields support these formats. An end date includes the full stated day/month/year/decade/century. There is no year zero. Approximation marks a date without inventing an uncertainty range. Exact dates use the proleptic Gregorian calendar; lunar/regnal dates require manual conversion.

## Notes and embeds

Existing note-backed events still open their notes. To add timeline properties to a note, run **Add or edit timeline dates for current note**. Updating an event preserves the note body and unrelated properties. Editing a title does not rename its note.

In Reading view or Live Preview, use:

````markdown
```historical-timeline
title: My historical timeline
folder: History notes/timeline
mode: vertical
```
````

Options: `title`, `folder`, `timeline`, `category`, `tag`, `search`, and `mode` (`cards`, `vertical`, `wall`, or `graph`). Legacy `scale` opens the vertical Timeline view. Options are optional strings. Folder filtering includes subfolders and applies to both storage choices.

Broader note↔timeline navigation and native link synchronization remain proposals pending approval. Plugin-only relationships are not automatically native Markdown links or backlinks.

## Installation and storage

Copy `main.js`, `manifest.json`, and `styles.css` into `YOUR_VAULT/.obsidian/plugins/historical-timeline/`, then reload the plugin. This is a custom local plugin, not a listing in Obsidian's community catalog. Updating these three files does not replace event data.

**Timeline-only events**, connections, saved analyses, and preferences are saved in `.obsidian/plugins/historical-timeline/data.json`. Include this file in backups/sync; uninstalling the plugin can remove it. Creating timeline-only events does not create notes. The **New event folder** setting applies to new note creation and scope metadata for new timeline-only events. **Scan folder** limits indexing; blank includes the vault. Use vault-relative paths.

### Sync to iPhone with Obsidian Sync

Historical Timeline supports Obsidian mobile. It is a custom plugin, so it must arrive through vault configuration sync rather than a search in the community plugin catalog. Sync both the plugin and its data; the release ZIP contains program files, not your saved events.

1. On the Mac, open **Settings → Sync → Vault configuration sync**. Enable **Active community plugin list** and **Installed community plugins** (called **Installed community plugin list** in some documentation). In Obsidian 1.13.7, the installed-plugins option explicitly includes plugin settings, including this plugin's `data.json`. These switches apply to community plugins generally, not only Historical Timeline.
2. Restart Obsidian and wait for **Fully synced**. Existing Markdown event notes must also be included in the vault sync.
3. On iPhone, install Obsidian and choose **Setup Obsidian Sync**. Sign into the same account and connect to the same remote vault as the Mac. If the phone already uses that remote vault, keep the existing connection. For a new phone vault, choose a local vault outside iCloud.
4. On iPhone, enable the same two options under **Settings → Sync → Vault configuration sync**. Sync settings are device-specific. Keep the default `.obsidian` configuration folder on both devices so they share the same plugin data.
5. Wait for the download to finish, fully close and reopen Obsidian, and enable **Historical Timeline** under **Settings → Community plugins** if needed. Open the command palette and run **Historical Timeline: Open timeline**. No keyboard shortcut is required.

Already-running timelines refresh when Obsidian reports changes to synced `data.json`; updating plugin code still requires a reload. Before switching devices to edit, let Sync finish on both devices. Plugin data is one JSON file, and simultaneous offline edits on different devices are not merged as independent event transactions.

Use one sync system for this vault. An iCloud subscription is not required for Obsidian Sync. If macOS syncs Desktop and Documents through iCloud, make sure a vault stored there is not also being managed by iCloud; see the official [switching guide](https://obsidian.md/help/sync/switch). Do not delete or relocate the existing vault until its sync and backup are verified.

For a manual move to another computer, copy the whole vault, including its hidden `.obsidian` folder. The plugin folder needs `main.js`, `styles.css`, `manifest.json`, and your current `data.json`; note-backed events additionally need their Markdown notes. Keep a separate backup of the vault.

Official instructions: [Set up Obsidian Sync](https://obsidian.md/help/sync/setup) and [Sync settings and selective syncing](https://obsidian.md/help/sync/settings). Physical iPhone behavior has not been tested on your device.

### Phone landscape (1.19.1)

Obsidian controls rotation. On iPhone, turn off **Portrait Orientation Lock** in Control Centre and hold the phone sideways; no plugin orientation setting is needed. See [Apple's rotation instructions](https://support.apple.com/en-ie/118226).

In short mobile landscape viewports, filters scroll with the page while the view tabs remain sticky, leaving more room to read. Spacing is reduced, Timeline uses two columns when the pane has room, and Wall chart/fishbone canvases scroll within the available height. Rotation uses CSS and the wall chart's existing size observer without rerendering the view or resetting its selection and expanded details. Desktop and portrait layouts keep their existing rules. Physical iPhone rotation has not been verified on your device.

### Mobile reading mode (1.21.0)

On mobile, the sticky toolbar now includes a **Reading / Editing** switch with a book or pencil icon. It stays available when filters are hidden. Mobile defaults to **Reading**; switching to **Editing** restores creation and editing tools. The choice is remembered on the current device only, separately from synced event data and zoom settings. Desktop behavior is unchanged.

In Reading mode, tap Chronicle or Wall chart events to view details in an Obsidian dialog. Timeline and fishbone selections continue to display their details normally. You can browse connected and undated events, search, filter, switch views, compare timelines, and pan or zoom charts. **Open note** deliberately opens a linked note in Obsidian's reading view.

Event, connection, and analysis editors are unavailable in Reading mode, including their command-palette entry points and save/delete paths. The switch is a protection against accidental edits inside the plugin, not a vault-wide file lock: Obsidian Sync and updates from notes continue to refresh the timeline. No event or note data is modified by switching modes.

### Mobile chart zoom (1.20.0)

On mobile, **Wall chart** and **Cause & Effect** support two-finger pinch zoom from **50% to 250%**, in portrait or landscape. Pinch around the part you want to examine, drag with one finger to pan, and tap an event to open it. After a drag or pinch, lifting your fingers does not select an event accidentally. Use **−**, **+**, or **100%** above the chart to adjust or reset the scale.

The graph viewport keeps a stable height while zooming. Rotation preserves the same chart position where the scroll limits allow it. Text, arrows, and branches scale together; Wall chart continues to pack events using their original text dimensions. Native gestures remain available outside the chart. Timeline, Chronicle, and desktop chart behavior stay unchanged.

Wall chart and fishbone scales are remembered separately on the current device. Only these two numbers are stored in device-local browser storage, outside plugin `data.json` and Obsidian Sync. If local storage is unavailable, the scales are remembered for the current session. No event data is changed by zooming.

Automated tests cover gestures, resize behavior, layout measurements, scroll restoration, and cleanup. Physical iPhone gesture behavior has not yet been verified.

**Markdown events** use frontmatter properties:

```yaml
timeline: [My timeline]
timeline-title: Event title
timeline-date: "1911-10-10"
timeline-end: "1912"
timeline-category: Politics
timeline-tags: [war, diplomacy]
timeline-important: true
timeline-summary: A short description
timeline-location: Place or region
timeline-source: Book title, page, or URL
timeline-perspectives:
  - historian: Historian name
    interpretation: Their interpretation
    source: Book and page
```

Only `timeline-date` is needed to identify a dated event; the filename is used when the title is absent. For an undated event, use `timeline-undated: true` and omit both date properties. For an abstract factor, use `timeline-kind: factor`; no date is required. Remove this property too when removing a factor note from the library. No timeline name is assigned when `timeline` is absent. To remove a note from the event library, remove its `timeline-date` and `timeline-undated` properties.

The editor protects against overwriting stale event changes. Invalid properties appear in the timeline's warnings. The plugin does not upload notes or event data. Summaries, perspectives, and citations render as plain text.

## Development

Requires Node.js 18+. No package installation is needed.

```sh
node scripts/build.js
node --test test/*.test.js
```

`src/main.js` implements the Obsidian integration, forms, and storage; `src/model.js` validates dates/events; `src/renderer.js` renders the views; `src/graph.js` implements fishbone layout and interactions; `src/chart-zoom.js` handles mobile chart gestures, and `src/chart-preferences.js` stores device-local scales, and `src/reading-preferences.js` remembers the mobile reading mode; `styles.css` supplies theme-aware styles. The build produces `main.js` with Obsidian as its only host-provided import.

Fishbone structure reference: [Juran’s guide to cause-and-effect diagrams](https://www.juran.com/blog/the-ultimate-guide-to-cause-and-effect-diagrams/).

References: [Obsidian public API](https://github.com/obsidianmd/obsidian-api), [developer documentation](https://docs.obsidian.md/). Desktop interactions were checked locally; physical mobile devices have not been tested.

Cause & Effect keeps its event selection separate from Timeline. Details open when you select an event in the fishbone and can be dismissed with **Close details**. A Timeline selection does not reopen graph details after saving.


## Editing and navigation improvements (1.15.0)

- Collapse or expand each analysis branch using its heading. Adding/removing factors updates only that section and preserves editor scroll; historian additions and suggestion selection also preserve scroll.
- Saved analyses render exactly the branches you authored. A chain such as Mukden → Lytton → League remains on one branch when grouped there. Only saved relationships create arrows; unlinked arguments retain their editor position. Cross-branch relationships remain in Connections below the chart.
- Event details offer **Show in Timeline** / **Show in Cause & Effect**. The latter prefers a saved analysis containing the event. Navigation uses the same underlying event and clears filters to reveal it; switching tabs alone keeps independent selections.
- Creating from Timeline selects and reveals the new dated event. Chronicle briefly outlines it. Wall chart refreshes retain horizontal, vertical, and outer-pane scroll positions.
- Already selected timeline names disappear from the reuse dropdown and other-line suggestions. Exact-match suggestions remain available when editing the current line.
- Unreferenced plugin-owned abstract and undated records are automatically removed from the active library after saved changes and on load. Every connection and saved analysis head, branch, and factor reference is checked across all timelines. Dated events and Markdown notes are retained. New/edited records are protected for that save. Removed records are backed up under `unusedEventArchive` in plugin `data.json`; deletion and archival are atomic.

Entering a complete decade or century automatically selects Period / decade / century. If an automatically detected period is changed back to a specific date with no end entered, the editor switches back. Manual period selections and explicit end dates are preserved.

Input suggestions match the beginning of a name or any word in it. Exact matches and name prefixes rank first. Event pickers also allow one-letter typos after four Latin letters, so Stresa and sresa both find The Stresa Front; u does not match Russia. Chinese phrases can match within a title. Full matches remain selectable. Connection suggestions match event titles, not date or type labels.

Suggestions use a single active highlight: arrow-key focus clears the previous row, including the initial default. Pointer hover does not add a second highlight while a suggestion has keyboard focus.

In every form editor—events, connections, and fishbone analyses—**Command+Enter** on Mac (**Ctrl+Enter** on Windows/Linux) creates or saves the current item using the same validation as its Save button. This works in both new and edit dialogs, including multiline fields. This shortcut is local to that dialog; no global hotkey is assigned. Plain Enter still completes suggestions, and Shift+Enter remains available for multiline input.

**Use previous timelines**, **Use previous category**, and **Use previous tags** appear beside their respective fields. The remembered value is shown beside each button, including an explicit empty state. Each button fills only its own field from your last successfully created event, including blank values, and leaves all other fields unchanged. The values persist across sessions for timeline-only and note-backed events; edits and cancelled forms do not replace them. Available after the first event is created with version 1.15.6 or later.

When comparing timelines in Wall chart, an event belonging to both appears once, marked **Both timelines**, in the inner space near the axis. Shared periods keep their duration bars. Exclusive events remain on their timeline’s side; distinct events with identical titles are preserved.

Press **Esc** while the timeline search box is focused to leave typing and return focus to the timeline page. Search text, filters, selection, and scroll position stay intact. The temporary Escape scope is released on blur or view disposal, leaving note shortcuts unchanged. This applies to standalone and embedded timelines.


### Event aliases and focused search (1.17.0)

Click **Add aliases** to reveal **Aliases (one name per line)**. Existing events show **Edit aliases (count)**. **Hide aliases** collapses the field without clearing it. Note-backed events use Obsidian's native `aliases` property; timeline-only events store the same list with their event data. Aliases work in search, connection pickers, analysis head/supporting-event pickers, undated-event search, and duplicate-name suggestions. Selecting an alias attaches the original event, preserving its identity and connections.

**Search in** selects All fields, Title and aliases, Summary, or Time. Time searches accept displayed dates and canonical input such as `1937-07-07`. Search scope follows the view state and Clear all filters resets it to All fields.

Wall-chart point stacks run from earliest to latest moving away from the axis. Within a year, dated entries precede an unspecified year; within a month, dated days precede an unspecified month. Above-axis stacks therefore display in reverse vertical order. Period packing still keeps short spans inside long overlapping spans, and shared comparison events stay near the axis.

New connections start with an empty Relationship field. Enter or select a relationship explicitly; editing preserves the saved value.

Search and suggestions ignore standalone English articles **a**, **an**, and **the** when searching a longer phrase, including aliases and undated events. Article-only inputs remain literal prefixes in suggestions. Names and saved data are unchanged; the Ignore case setting still applies.


### Navigation and perspective search (1.18.0)

The standalone plugin page uses Obsidian's native Back and Forward history for event selections, view tabs, linked-event navigation, and fishbone analysis selection. Search typing and filter-panel toggles do not add history entries. Returning to Timeline restores the selected event and filters and reveals the event. Normal event selections keep the event list mounted, preserving its scroll and keyboard focus. Embedded timelines do not take over a note's navigation history.

Choose **Historical perspectives** under **Search in** to search the event's historian names, interpretations, and sources. **All fields** includes these perspectives too. Ignore case and article-insensitive search work in this scope, and the scope is retained when switching views. Saved fishbone analyses keep their existing filter behavior; this scope searches event perspectives.

### Obsidian Sync and rendering improvements (1.19.0)

- Uses Obsidian's public external-settings callback to refresh synced events, connections, analyses, and preferences. Remote refreshes are read-only and share the local save queue; unchanged data does not redraw the view. Stale editor saves still ask you to reopen the item instead of overwriting a synced change.
- Editing ordinary notes or unrelated properties no longer redraws timelines. Relevant note changes still update the index. Deferred reads, writes, and refresh timers stop when the plugin unloads.
- Earlier causal links are built only when expanded, with a shared node limit, including wide branching histories. Relationship lookups reuse indexes, and empty searches skip text normalization.
- Search normalizes Unicode consistently across views and pickers. Article matching avoids regular-expression lookbehind for broader iPhone WebView compatibility.
- View tabs and long detail buttons/text wrap within narrow panes. Wall chart and fishbone diagrams retain their own scrollable canvases.

These changes keep the existing data format and do not convert timeline-only records into notes or native backlinks. No separate sync service is introduced. Automated checks cover data refresh, save conflicts, lifecycle cleanup, matching, and graph expansion; visual behavior on a physical iPhone still needs confirmation.
