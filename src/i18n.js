// Minimal i18n for the `incipit` CLI.
//
// All user-facing prose in menu.js goes through `t(key, vars)`. The
// active locale is a module-level variable set once by `setLocale`
// (called from the menu bootstrap after reading config.js). Keys are
// flat dotted strings so they are greppable without tooling.
//
// Intentionally NOT translated:
//   - the frontispiece tagline ("A frontend rework of the official /
//     Claude Code VS Code extension") — it is the project's
//     brand-level identity, kept verbatim in sync with the git/package
//     description, and reads as a literary epigraph, not UI copy
//   - the ledger labels (Target / Extension / Restore) — these are
//     typography/administration terms, not prose
//
// When `setLocale` has not been called yet, `t()` falls back to
// English — this matches the non-interactive subcommand behaviour
// (`incipit apply`, `incipit restore`, `incipit --help`) for users who have
// never run the interactive menu.

'use strict';

const DEFAULT_LOCALE = 'en';
let currentLocale = DEFAULT_LOCALE;

const STRINGS = {
  en: {
    // --- help ---
    'help.usage_heading':       'Usage',
    'help.cmd_default':         'open the interactive frontispiece menu (default)',
    'help.cmd_apply':           'apply the interface patch without entering the menu',
    'help.cmd_restore':         'restore the official Claude Code files',
    'help.cmd_clean_backups':   'delete legacy incipit backup files',
    'help.cmd_list_targets':    'list every known Claude Code target and exit',
    'help.cmd_version':         'print the CLI version',
    'help.cmd_help':            'show this help',
    'help.cmd_lang':            'set the saved CLI language',
    'help.cmd_no_update_check': 'skip the npm-registry update check for this run',
    'help.cmd_extensions_dir':  'use this extensions directory for apply/restore instead of the saved default',
    'help.cmd_settings_path':   'use this settings.json path instead of auto-deriving (paired with --extensions-dir)',
    'help.reload_hint':         'After applying, run Developer: Reload Window in VS Code to reload the extension.',
    'help.upgrade_hint':        'When Claude Code upgrades, the patch is overwritten — just run incipit again.',

    // --- ledger (the three lines under the title) ---
    'ledger.extension_missing': 'Claude Code extension not detected',

    // --- menu table of contents ---
    'menu.apply':               'Apply interface patch',
    'menu.restore':             'Restore official Claude Code',
    'menu.configure':           'Configure',
    'menu.target':              'Manage Claude Code targets',
    'menu.cli_language':        'CLI language',
    'menu.connect_us':          'Connect us',
    'menu.cleanup_backups':     'Clean legacy backup files',
    'menu.quit':                'Quit',
    'menu.invalid':             'Invalid input.',
    'menu.operation_failed':    'Operation failed: {msg}',
    'menu.press_enter':         'Press Enter to continue ...',
    'menu.tty_required':        'Interactive menu requires a terminal.',
    'menu.tty_hint':            'For non-interactive use, pass one of: incipit apply / incipit restore / incipit --help',

    // --- interactive keyboard hints (shown at the bottom of each screen) ---
    'hint.main':                '↑↓ move · Enter select · q quit',
    'hint.configure':           '↑↓ move · Space/Enter change · apply + Reload after changes · b back',
    'hint.experimental':        '↑↓ move · Space/Enter toggle · apply + Reload after changes · b back',
    'hint.connect':             'Enter / b back',
    'hint.picker':              '↑↓ move · Enter confirm · b back',

    // --- connect screen ---
    'connect.heading':          'Connect us',
    'connect.back':             'Back',

    // --- apply flow ---
    'apply.title':              '[ Apply Claude Code interface patch ]',
    'apply.extension_header':   'Claude Code extension',
    'apply.version_header':     'Detected version',
    'apply.restore_point_failed': 'Official restore point failed: {msg}',
    'apply.missing_original':   '(original file does not exist)',
    'apply.applying':           'Applying interface patch ...',
    'apply.apply_failed':       'Patch failed: {msg}',
    'apply.custom_icon_invalid':'Custom icon rejected before apply: {msg}',
    'apply.restore_missing.heading': 'Official restore point is missing',
    'apply.restore_missing.body': 'This Claude Code already contains an older incipit patch, but incipit cannot find the original official files. This usually only happens after applying an old incipit version.',
    'apply.restore_missing.target': 'Target: {app} · Claude Code {version}',
    'apply.restore_missing.option_exit': '1. Exit now. In {app}, install or update Claude Code once, then run incipit again. (Recommended)',
    'apply.restore_missing.option_download': '2. Download the matching official Claude Code VSIX from Marketplace and create the restore point.',
    'apply.restore_missing.prompt': 'Choose 1 or 2 [1]: ',
    'apply.restore_missing.invalid': 'Please enter 1 or 2.',
    'apply.restore_missing.exit': 'Exited before applying. Update Claude Code in {app}, then run incipit again.',
    'apply.restore_missing.non_interactive': 'This rare repair needs a choice. Run incipit in an interactive terminal, or update Claude Code in {app} and run apply again.',
    'apply.restore_missing.downloading': 'Downloading official Claude Code VSIX and creating restore point ...',
    'apply.restore_missing.download_failed': 'Current Claude Code already contains incipit, but no official restore point exists. Marketplace VSIX recovery failed: {msg}',
    'apply.reload_action':      'Developer: Reload Window',
    'apply.restart_action':     'restart {app}',
    'apply.done':               'Done. In {app}, run {reload}, or {restart}.',
    'apply.upgrade_hint':       'Hint: when Claude Code upgrades, the patch is overwritten — run incipit again.',
    'apply.not_detected':       'Claude Code extension not detected: {msg}',
    'apply.report.restore_heading': 'Official restore point',
    'apply.report.patch_heading':  'Patch',
    'apply.report.config_label':   'Current configuration:',
    'apply.report.file_count':     '{count} files',
    'apply.report.summary_all_current': 'All patch files are already current.',
    'apply.report.summary_changed': 'Updated {updated} patch entries; {current} already current.',
    'apply.report.summary_changed_no_current': 'Updated {updated} patch entries.',
    'apply.report.warnings_heading': 'Applied with graceful degradation:',
    'apply.report.restore_existing': 'already available',
    'apply.report.restore_created': 'created from the current official files',
    'apply.report.restore_migrated': 'migrated from a legacy backup',
    'apply.report.restore_downloaded': 'created from the official Marketplace VSIX',
    'apply.report.restore_extended': 'extended with the official icon files',
    'apply.report.restore_extension_desc': 'official extension entrypoint',
    'apply.report.restore_webview_index_desc': 'official webview bundle',
    'apply.report.restore_cleanup_desc': 'restore/delete {count} incipit-owned paths',
    'apply.report.restore_icons_desc': 'restore the {count} official Claude icon slots',
    'apply.report.desc.extension_js': 'allow local webview assets, preload incipit styles, connect the badge bridge',
    'apply.report.desc.webview_dir': 'webview runtime and reading resources',
    'apply.report.desc.webview_index_js': 'write CLI config, math preprocessing, diff editor patches, and the runtime loader',
    'apply.report.desc.enhance_js': 'start the incipit runtime',
    'apply.report.desc.enhance_shared_js': 'share config, styles, and DOM guards',
    'apply.report.desc.runtime_kernel_js': 'central host state and streaming scheduler',
    'apply.report.desc.enhance_footer_badge_js': 'footer badge and status display',
    'apply.report.desc.enhance_thinking_js': 'thinking block typesetting',
    'apply.report.desc.enhance_typography_js': 'math, code highlighting, and CJK punctuation typography',
    'apply.report.desc.enhance_legacy_js': 'tool fold, diff island, and local-history actions',
    'apply.report.desc.host_probe_js': 'tag host DOM for incipit styles and interactions',
    'apply.report.desc.host_badge_cjs': 'local-history bridge between the host and webview',
    'apply.report.desc.math_tokens_js': 'math source tokenizer',
    'apply.report.desc.math_rewriter_js': 'formula rendering handoff',
    'apply.report.desc.theme_css': 'warm-black reading theme',
    'apply.report.desc.conversation_outline_css': 'user prompt navigation styles',
    'apply.report.desc.warm_white_css': 'warm-white theme override',
    'apply.report.desc.ink_black_css': 'ink-black theme override',
    'apply.report.desc.webview_file_generic': 'incipit webview runtime file',
    'apply.report.desc.asset_katex': 'formula rendering assets, {files}',
    'apply.report.desc.asset_hljs': 'code highlighting assets, {files}',
    'apply.report.desc.asset_fonts': 'webview font assets, {files}',
    'apply.report.desc.asset_effort_brain': 'effort brain icons, {files}',
    'apply.report.desc.asset_generic': 'webview asset tree, {files}',
    'apply.report.desc.workbench_overlay_off': 'off by default; Workbench left untouched',
    'apply.report.desc.workbench_overlay_unsupported': 'unsupported host or ambiguous editor program path',
    'apply.report.desc.workbench_overlay_patched': 'patched VS Code Workbench floating editor overlay',
    'apply.report.desc.workbench_overlay_already_current': 'Workbench overlay already current',
    'apply.report.desc.workbench_overlay_restored': 'Workbench overlay restored to official bytes',
    'apply.report.desc.workbench_overlay_already_official': 'Workbench already official',
    'apply.report.desc.workbench_overlay_degraded': 'requested, but editor not safely confirmed; overlay skipped this apply',
    'apply.report.desc.companion_extension': 'Claude selection reference CodeLens, {files}',
    'apply.report.overlay_degraded_heading': '⚠ Editor overlay was NOT applied this run (everything else applied; your setting is unchanged)',
    'apply.report.overlay_degraded_reason_only_official_vscode': 'This Claude Code target is not official VS Code Stable/Insiders, so the editor program file cannot be safely confirmed.',
    'apply.report.overlay_degraded_reason_workbench_not_found': 'No VS Code Stable/Insiders Workbench program file was found for this target.',
    'apply.report.overlay_degraded_reason_ambiguous_workbench': 'Multiple possible Workbench program files were found; none can be uniquely + safely chosen.',
    'apply.report.overlay_degraded_reason_unknown': 'The editor Workbench could not be uniquely + safely confirmed for this target.',
    'apply.report.overlay_degraded_reason_apply_error': 'Applying the editor overlay failed, so it was skipped:',
    'apply.report.overlay_degraded_hint': 'The default reference entry (CodeLens via the companion) is unaffected. To use the overlay, run Claude Code in official VS Code Stable/Insiders; or turn off "Editor overlay (reference text or file)" in Configure to silence this notice.',
    'apply.report.overlay_degraded_candidates': 'Candidates: {list}',
    'apply.report.desc.system_fonts': 'install IBM Plex Serif, {files}',
    'apply.report.desc.custom_icon_dir': 'custom icon from {name}, {files}',
    'apply.report.desc.custom_icon_slot': 'sanitized custom icon bytes',
    'apply.report.desc.custom_icon_official_slot': 'official PNG retained for an SVG source',

    // --- restore flow ---
    'restore.title':            '[ Restore official Claude Code ]',
    'restore.restore_root':     'Restore point root: {path}',
    'restore.workbench_restore_root':'Workbench restore point root: {path}',
    'restore.restore_point_dir':'Restore point: {dir}',
    'restore.workbench_restore_point_dir':'Workbench restore point: {dir}',
    'restore.cancelled':        'Cancelled.',
    'restore.confirm_official': 'Restore this Claude Code target to official files? (y/N): ',
    'restore.already_official': 'This Claude Code target already looks official; nothing to restore.',
    'restore.done':             'Restored {restored} files, skipped {skipped}.',
    'restore.workbench_restored':'Workbench editor overlay restored.',
    'restore.workbench_already_official':'Workbench editor overlay already looks official.',
    'restore.workbench_unsupported':'Workbench editor overlay was not checked for this host.',
    'restore.companion_removed':'Companion extension removed ({count}).',
    'restore.companion_none':   'No companion extension install found.',
    'restore.reload_hint':      'Run Developer: Reload Window in VS Code to reload.',

    // --- cleanup flow ---
    'cleanup.title':            '[ Clean legacy backup files ]',
    'cleanup.backup_root':      'Legacy backup root: {path}',
    'cleanup.summary':          '{files} files / {dirs} directories / {size}',
    'cleanup.none':             'No legacy backup files found.',
    'cleanup.confirm':          'Delete all legacy backup files under this root? (y/N): ',
    'cleanup.done':             'Deleted legacy backups: {files} files / {dirs} directories / {size}.',

    // --- update check ---
    'update.available':         'A new version is available: {current} → {latest}',
    'update.command':           'Run: npm install -g incipit@latest --prefer-online',
    'update.prompt':            'Update now? [Y/n]: ',
    'update.skipped':           'Continuing with the current version.',
    'update.upgrading':         'Upgrading incipit…',
    'update.upgrade_succeeded': 'Upgrade complete. Please re-run incipit.',
    'update.upgrade_failed':    'Upgrade failed. You can retry manually with: npm install -g incipit@latest --prefer-online',

    // --- first-run language picker ---
    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',
    'language.heading':         'CLI language',

    // --- target screen ---
    'target.heading':           '── Manage Claude Code targets ──',
    'target.scanning':          'Scanning for Claude Code installations...',
    'target.no_targets':        'No Claude Code installation detected.',
    'target.no_targets_hint':   "Use '+ Add target' below to point at one manually.",
    'target.list_heading':      'Known targets',
    'target.add_label':         '+ Add target (folder dialog)',
    'target.scan_label':        '⌕ Deep scan (find more installs)',
    'target.remove_label':      '× Remove target',
    'target.back':              'Back',
    'target.column_auto':       'auto',
    'target.column_manual':     'manual',
    'target.column_invalid':    'invalid',
    'target.confirm_remove':    'Remove this manual target? (y/N): ',
    'target.removed':           'Target removed.',
    'target.added':             'Target added: {label}',
    'target.cannot_remove_auto':'Auto-detected entries cannot be removed; remove the underlying installation instead.',
    'target.no_manual_to_delete':'No manual targets to delete (auto-detected entries cannot be removed).',
    'target.delete_mode_heading':'Pick a target to remove',
    'target.hint':              'a add · s scan · d remove · b back',
    'target.hint_delete':       '↑↓ pick · Enter remove · Esc cancel',

    // --- add target wizard ---
    'target.add.heading':       '── Add Claude Code installation ──',
    'target.add.intro':         'A system folder dialog will open next. Pick any of the following:',
    'target.add.intro_dialog_word': 'folder',
    'target.add.option_a':      'A VS Code-family extensions directory',
    'target.add.option_a_egs':  'e.g.  ~/.vscode/extensions',
    'target.add.option_a_egs2': '      ~/.cursor/extensions',
    'target.add.option_b':      'A portable / Scoop data directory',
    'target.add.option_b_egs':  'e.g.  ~/scoop/apps/vscode/current/data',
    'target.add.option_b_egs2': '      ~/scoop/persist/vscode/data or <unzipped>/data',
    'target.add.option_c':      'A specific anthropic.claude-code-X.Y.Z directory',
    'target.add.option_c_eg':   '(use this to pin a single version)',
    'target.add.proceed':       'Open folder dialog',
    'target.add.cancel':        'Cancel',
    'target.add.dialog_title':  'Select VS Code data or extensions folder',
    'target.add.dialog_unavailable_title': 'Folder dialog not available',
    'target.add.dialog_unavailable_no_display':
                                'No graphical display detected ($DISPLAY / $WAYLAND_DISPLAY are unset). incipit cannot open a folder dialog on a headless host.',
    'target.add.dialog_unavailable_no_zk':
                                'Neither zenity nor kdialog is installed. Install one of them, or run incipit from a machine with a graphical desktop.',
    'target.add.dialog_unavailable_other':
                                'No GUI folder picker is reachable on this platform.',
    'target.add.dialog_failed': 'Folder dialog failed: {msg}',
    'target.add.cancelled':     'Cancelled.',

    // --- identify outcomes ---
    'target.identify.kind_extension_version':  'Single extension version',
    'target.identify.kind_extensions_dir':     'Extensions directory',
    'target.identify.kind_portable_data':      'Portable data directory',
    'target.identify.kind_portable_data_empty':'Portable data directory (no Claude Code yet)',
    'target.identify.recognized':              'Recognized',
    'target.identify.label_kind':              'Kind',
    'target.identify.label_extensions':        'Extensions dir',
    'target.identify.label_settings':          'settings.json',
    'target.identify.label_version':           'Latest version found',
    'target.identify.prompt_label':            'Give this target a name (optional):',
    'target.identify.save':                    'Save',
    'target.identify.repick':                  'Pick another folder',
    'target.identify.cancel':                  'Cancel',
    'target.identify.no_settings_inferred':    '(could not auto-derive; will prompt for it on first apply)',
    'target.identify.empty_data_warn':         'No anthropic.claude-code-* extension was found here yet. The target will be saved, but apply will refuse until Claude Code is installed under it.',

    // --- identify failures ---
    'target.identify.fail_heading':            'Could not recognize this folder',
    'target.identify.fail_picked':             'You picked',
    'target.identify.fail_unknown':
        'This does not look like a place a VS Code-family editor keeps Claude Code.\n' +
        'Pick one of these instead:\n' +
        '  · the editor data/profile folder, e.g.  ~/.vscode  ~/.cursor  ~/.vscode-insiders\n' +
        '  · its extensions/ subfolder\n' +
        '  · a single anthropic.claude-code-* version folder\n' +
        '  · a portable data/ folder (with extensions/ + user-data/ inside)',
    'target.identify.fail_profile_no_claude':
        'This looks like a VS Code-family editor profile, but no Claude Code\n' +
        'extension is installed under its extensions/ folder. Install Claude Code\n' +
        'in that editor first, or pick the profile/extensions folder of the\n' +
        'editor that actually has it.',
    'target.identify.fail_standard_install':
        'You picked a VS Code-family program installation directory, but on this machine\n' +
        'that host appears to run in standard (non-portable) mode: extensions and settings\n' +
        'live in the system default user location, NOT inside the program directory. The\n' +
        'standard install should appear in the auto-detected list if Claude Code is installed.\n' +
        '\n' +
        'If you meant to add a portable or Scoop copy, confirm its install folder\n' +
        'contains a data/ subfolder (with data/extensions and data/user-data inside),\n' +
        'then pick that data/ folder instead of the program root.',
    'target.identify.fail_repick':             'Pick another folder',
    'target.identify.fail_back':               'Back',
    'target.identify.fail_scan_here':          '⌕ Deep scan inside this folder',

    // --- deep scan ---
    'target.scan.heading':            '── Deep scan for Claude Code ──',
    'target.scan.progress_heading':   'Scanning…',
    'target.scan.stat':               'scanned {dirs} dirs · found {found} · {secs}s',
    'target.scan.scanning_empty':     'searching… (nothing new yet)',
    'target.scan.progress_hint':      'press any key to stop and use what was found',
    'target.scan.results_heading':    'Deep scan results',
    'target.scan.results_summary':    '{from}–{to} of {count} found',
    'target.scan.results_hint':       '↑↓ move   ·   PgUp/PgDn page   ·   Home/End ends — list only',
    'target.scan.results_actions':    '[Space] toggle    [↵] add selected ({n})\n[a] select all    [n] select none    [Esc] cancel',
    'target.scan.none_found':         'No new Claude Code installs were found (already-known targets are hidden).',
    'target.scan.timed_out':          'time limit reached — results may be incomplete; pick a more specific folder for a full scan',
    'target.scan.stopped':            'stopped',
    'target.scan.added':              'Added {n} target(s).',
    'target.scan.added_none':         'Nothing selected — no targets added.',

    // --- apply pre-picker ---
    'target.apply_picker.heading':             '── Confirm target for apply ──',
    'target.apply_picker.use_label':           'Use this target',
    'target.apply_picker.change_label':        'Use a different target',
    'target.apply_picker.cancel_label':        'Cancel',
    'target.apply_picker.no_active':
        'No active target is set. Run \'4. Target\' from the main menu first.',

    // --- non-interactive apply / restore / list-targets ---
    'cli.no_targets_for_apply':
        'No Claude Code installation detected for apply. Run "incipit" interactively to add a target, or pass --extensions-dir explicitly.',
    'cli.no_targets_for_restore':
        'No Claude Code installation detected for restore. Run "incipit" interactively to add a target, or pass --extensions-dir explicitly.',
    'cli.ambiguous_targets_heading':
        'Multiple Claude Code installations detected. Pick one explicitly:',
    'cli.ambiguous_targets_template_heading':
        'Run one of:',
    'cli.ambiguous_targets_or_list':
        'Or:  incipit list-targets    # see full candidates',
    'cli.bad_extensions_dir_missing':
        'extensions directory does not exist: {path}',
    'cli.bad_extensions_dir_not_dir':
        'extensions directory is not a folder: {path}',
    'cli.bad_extensions_dir_no_cc':
        'no anthropic.claude-code-* found under: {path}',
    'cli.bad_settings_parent_missing':
        'parent directory of settings-path does not exist: {path}\n  (this usually means the host VS Code has never been launched on this machine)',
    'cli.list_targets_empty':
        'No Claude Code installations detected.\nRun "incipit" interactively and use "+ Add target" to register one.',
    'cli.list_targets_lastused_marker':
        'last-used',
    'cli.list_targets_kind_auto':
        'auto',
    'cli.list_targets_kind_manual':
        'manual',
    'cli.list_targets_label_extensions':
        'extensions',
    'cli.list_targets_label_settings':
        'settings',
    'cli.list_targets_label_version':
        'version',
    'cli.list_targets_invalid_marker':
        'invalid (extensions directory missing or has no Claude Code)',

    // --- configure menu ---
    'configure.heading':        '── Configure ──',
    'configure.feature_math':   'Math formula rendering',
    'configure.feature_session':'Session usage',
    'configure.experimental':   'Experimental',
    'configure.experimental_value_on':'1 enabled',
    'configure.experimental_value_off':'none enabled',
    'configure.experimental_heading':'── Experimental ──',
    'configure.feature_editor_overlay':'Editor overlay (reference text or file)',
    'configure.experimental_overlay_desc_what':'After selecting code, shows buttons that insert @file or @file#range.',
    'configure.experimental_overlay_desc_why':'Experimental: it changes VS Code program files, so Code may show a damage warning.',
    'configure.experimental_overlay_desc_restore':'Enable or disable, then Apply + Reload. Turn it off and apply, or Restore, to undo.',
    'configure.param_body_size':'Body font size',
    'configure.reset':          'Reset defaults',
    'configure.back':           'Back',
    'configure.on':             'on',
    'configure.off':            'off',
    'configure.reset_confirm':  'Reset features and appearance to defaults? (y/N): ',
    'configure.reset_done':     'Configuration reset.',
    'configure.saved_hint':     'Saved. Re-run 1. Apply to activate.',
    'configure.body_size_heading':'Body font size',
    'configure.body_size_default_mark':'(default)',
    'configure.param_palette':  'Palette',
    'configure.palette_heading':'Palette',
    'configure.palette_warm_black':'Warm black',
    'configure.palette_ink_black':'Ink black',
    'configure.palette_warm_white':'Warm white',
    'configure.palette_warm_white_bold':'Warm white (bold body)',
    'configure.param_body_font':  'Body font',
    'configure.param_code_font':  'Code font',
    'configure.param_icon':       'App icon',
    'configure.icon_official':    'Official Claude',
    'configure.icon_custom':      'Custom: {name}',
    'configure.icon_invalid':     'Custom setting invalid',
    'configure.icon_missing':     'Custom file missing',
    'configure.icon_heading':     'App icon',
    'configure.icon_choose':      'Choose SVG or transparent PNG…',
    'configure.icon_clear':       'Clear custom icon setting',
    'configure.icon_dialog_title':'Choose an SVG or transparent PNG icon',
    'configure.icon_saved':       'Custom icon saved: {name}',
    'configure.icon_cleared':     'The custom icon setting was cleared.',
    'configure.icon_restore_hint':'If this icon was already applied, run Restore once to put the official Claude icon back on disk.',
    'configure.icon_dialog_failed':'The file picker failed: {msg}',
    'configure.icon_dialog_unavailable_no_powershell':'The Windows file picker is unavailable because PowerShell was not found.',
    'configure.icon_dialog_unavailable_no_osascript':'The macOS file picker is unavailable because osascript was not found.',
    'configure.icon_dialog_unavailable_no_display':'No desktop display is available for a file picker in this Linux session.',
    'configure.icon_dialog_unavailable_no_zenity_no_kdialog':'Install zenity or kdialog to choose an icon file on Linux.',
    'configure.icon_error_opaque_png':'That PNG has no actually transparent pixel. Use a transparent-background PNG or an SVG.',
    'configure.icon_error_svg':'The SVG was rejected for safety ({code}). Remove scripts, event handlers, embedded HTML, and external references.',
    'configure.icon_error_png':'The PNG is malformed or unsafe to decode ({code}). Export it again as a normal transparent PNG.',
    'configure.icon_error_source':'The saved icon file cannot be used ({code}). Choose the file again.',
    'configure.icon_error_generic':'The icon could not be used: {msg}',
    'configure.body_font_heading':'Body font',
    'configure.code_font_heading':'Code font',
    'configure.font_custom_prompt':'Enter CSS font-family (e.g. \'LXGW WenKai\', serif): ',
    'configure.font_custom_warning_body':'The default font scheme is incipit\'s long-form reading baseline, designed and optimized around weights, emphasis, and CJK/Latin rhythm.',
    'configure.font_custom_warning_code':'Custom code fonts may affect alignment, diffs, and tool output. Restore Rec Mono Linear if anything looks wrong.',
    'configure.font_custom_label':'Custom',
    'configure.font_plex_hei':    'IBM Plex Serif + Noto Sans SC',
    'configure.font_plex_serif':  'IBM Plex Serif + LXGW WenKai',
    'configure.font_rec_mono':    'Rec Mono Linear',
    'configure.font_jetbrains_mono':'JetBrains Mono',
    'configure.font_system_mono': 'System mono',
    'configure.font_custom':      'Custom',
    'apply.font_custom_value':    'Custom',

    // --- apply result summary ---
    'apply.summary_heading':    'Current configuration',
    'apply.summary_on':         'on',
    'apply.summary_off':        'off',
    'apply.summary_hint':       "Use '3. Configure' to adjust; re-run '1. Apply' to activate.",
  },
  zh: {
    // --- help ---
    'help.usage_heading':       '用法',
    'help.cmd_default':         '交互式扉页菜单(默认)',
    'help.cmd_apply':           '直接应用界面补丁，不进菜单',
    'help.cmd_restore':         '恢复为官方 Claude Code 文件',
    'help.cmd_clean_backups':   '删除旧版 incipit 备份文件',
    'help.cmd_list_targets':    '列出所有已知 Claude Code 目标后退出',
    'help.cmd_version':         '显示 CLI 版本',
    'help.cmd_help':            '显示本帮助',
    'help.cmd_lang':            '设置已保存的 CLI 界面语言',
    'help.cmd_no_update_check': '本次运行跳过 npm 源的新版本检查',
    'help.cmd_extensions_dir':  '指定 apply/restore 使用的扩展目录，覆盖默认目标',
    'help.cmd_settings_path':   '搭配 --extensions-dir 使用，显式指定 settings.json 路径',
    'help.reload_hint':         '应用后请在 VS Code 里执行 Developer: Reload Window 让扩展重载。',
    'help.upgrade_hint':        'Claude Code 扩展升级后补丁会被覆盖,再跑一次 incipit 即可。',

    'ledger.extension_missing': '未检测到 Claude Code 扩展',

    'menu.apply':               '应用界面补丁',
    'menu.restore':             '恢复官方 Claude Code',
    'menu.configure':           '配置',
    'menu.target':              '管理 Claude Code 目标位置',
    'menu.cli_language':        'CLI 界面语言',
    'menu.connect_us':          'Connect us',
    'menu.cleanup_backups':     '清理旧版备份文件',
    'menu.quit':                '退出',
    'menu.invalid':             '无效输入。',
    'menu.operation_failed':    '操作失败：{msg}',
    'menu.press_enter':         '按回车继续...',
    'menu.tty_required':        '交互菜单需在终端中运行。',
    'menu.tty_hint':            '非交互场景请使用：incipit apply / incipit restore / incipit --help',

    // --- interactive keyboard hints (shown at the bottom of each screen) ---
    'hint.main':                '↑↓ 移动 · 回车 确认 · q 退出',
    'hint.configure':           '↑↓ 移动 · 空格/回车 修改 · 改后需 Apply + Reload · b 返回',
    'hint.experimental':        '↑↓ 移动 · 空格/回车 勾选 · 改后需 Apply + Reload · b 返回',
    'hint.connect':             '回车 / b 返回',
    'hint.picker':              '↑↓ 移动 · 回车 确认 · b 返回',

    'connect.heading':          'Connect us',
    'connect.back':             '返回',

    'apply.title':              '[应用 Claude Code 界面补丁]',
    'apply.extension_header':   'Claude Code 扩展',
    'apply.version_header':     '检测版本',
    'apply.restore_point_failed': '官方恢复点创建失败：{msg}',
    'apply.missing_original':   '(原文件不存在)',
    'apply.applying':           '正在应用界面补丁 ...',
    'apply.apply_failed':       '应用失败：{msg}',
    'apply.custom_icon_invalid':'自定义图标在 apply 前被拒绝：{msg}',
    'apply.restore_missing.heading': '官方恢复点缺失',
    'apply.restore_missing.body': '这个 Claude Code 已经包含旧 incipit 补丁，但本机找不到当时保存的官方文件。通常只会发生在很早版本的 incipit apply 过以后。',
    'apply.restore_missing.target': '目标：{app} · Claude Code {version}',
    'apply.restore_missing.option_exit': '1. 退出。先在 {app} 里安装/更新 Claude Code，让编辑器覆盖为官方最新版，然后再运行 incipit。（推荐）',
    'apply.restore_missing.option_download': '2. 下载同版本官方 Claude Code VSIX，用它创建恢复点后继续 apply。',
    'apply.restore_missing.prompt': '请选择 1 或 2 [1]：',
    'apply.restore_missing.invalid': '请输入 1 或 2。',
    'apply.restore_missing.exit': '已退出，尚未 apply。请先在 {app} 里安装/更新 Claude Code，然后再运行 incipit。',
    'apply.restore_missing.non_interactive': '这个稀有修复需要你选择。请在可交互终端运行 incipit，或先在 {app} 里更新 Claude Code 后再 apply。',
    'apply.restore_missing.downloading': '正在下载官方 Claude Code VSIX 并创建恢复点 ...',
    'apply.restore_missing.download_failed': '当前 Claude Code 已含 incipit，但没有官方恢复点；Marketplace VSIX 恢复失败：{msg}',
    'apply.reload_action':      'Developer: Reload Window',
    'apply.restart_action':     '重启 {app}',
    'apply.done':               '已完成。请在 {app} 里执行 {reload}，或{restart}。',
    'apply.upgrade_hint':       '提示：Claude Code 扩展更新后补丁会被覆盖，届时再跑一次 incipit 即可。',
    'apply.not_detected':       '未检测到 Claude Code 扩展：{msg}',
    'apply.report.restore_heading': '官方恢复点',
    'apply.report.patch_heading':  'Patch',
    'apply.report.config_label':   '当前配置：',
    'apply.report.file_count':     '{count} 个文件',
    'apply.report.summary_all_current': '所有补丁文件已是最新。',
    'apply.report.summary_changed': '更新 {updated} 项，其余 {current} 项已是最新。',
    'apply.report.summary_changed_no_current': '更新 {updated} 项。',
    'apply.report.warnings_heading': '已应用，但有可恢复降级：',
    'apply.report.restore_existing': '已存在',
    'apply.report.restore_created': '已从当前官方文件创建',
    'apply.report.restore_migrated': '已从旧版备份迁移',
    'apply.report.restore_downloaded': '已从官方 Marketplace VSIX 创建',
    'apply.report.restore_extended': '已补录官方图标文件',
    'apply.report.restore_extension_desc': '官方扩展入口',
    'apply.report.restore_webview_index_desc': '官方 webview bundle',
    'apply.report.restore_cleanup_desc': '恢复/删除 {count} 个 incipit 自有路径',
    'apply.report.restore_icons_desc': '恢复 {count} 个官方 Claude 图标槽位',
    'apply.report.desc.extension_js': '允许本地 webview 资源、提前加载 incipit 样式、接入 badge bridge',
    'apply.report.desc.webview_dir': 'webview runtime 与阅读资源',
    'apply.report.desc.webview_index_js': '写入 CLI 配置、数学预处理、diff 编辑器补丁、runtime loader',
    'apply.report.desc.enhance_js': '启动 incipit runtime',
    'apply.report.desc.enhance_shared_js': '共享配置、样式与 DOM guard',
    'apply.report.desc.runtime_kernel_js': '集中宿主状态与流式调度',
    'apply.report.desc.enhance_footer_badge_js': 'footer badge 与状态显示',
    'apply.report.desc.enhance_thinking_js': 'thinking block 排版',
    'apply.report.desc.enhance_typography_js': '数学、代码高亮、CJK 标点排版',
    'apply.report.desc.enhance_legacy_js': 'tool fold、diff island、本地历史动作',
    'apply.report.desc.host_probe_js': '标记宿主 DOM，供样式和交互定位',
    'apply.report.desc.host_badge_cjs': '本地历史与 webview 通信',
    'apply.report.desc.math_tokens_js': '数学源码切分',
    'apply.report.desc.math_rewriter_js': '公式渲染交接',
    'apply.report.desc.theme_css': '暖黑阅读主题',
    'apply.report.desc.conversation_outline_css': '用户指令导航样式',
    'apply.report.desc.warm_white_css': '暖白主题覆盖',
    'apply.report.desc.ink_black_css': '墨黑主题覆盖',
    'apply.report.desc.webview_file_generic': 'incipit webview runtime 文件',
    'apply.report.desc.asset_katex': '公式渲染资源，{files}',
    'apply.report.desc.asset_hljs': '代码高亮资源，{files}',
    'apply.report.desc.asset_fonts': 'webview 字体资源，{files}',
    'apply.report.desc.asset_effort_brain': 'effort 大脑图标，{files}',
    'apply.report.desc.asset_generic': 'webview 资源目录，{files}',
    'apply.report.desc.workbench_overlay_off': '默认关闭；不触碰 Workbench',
    'apply.report.desc.workbench_overlay_unsupported': '宿主不支持或编辑器程序路径有歧义',
    'apply.report.desc.workbench_overlay_patched': '已 patch VS Code Workbench 编辑器浮层',
    'apply.report.desc.workbench_overlay_already_current': 'Workbench 浮层已是最新',
    'apply.report.desc.workbench_overlay_restored': 'Workbench 浮层已恢复为官方字节',
    'apply.report.desc.workbench_overlay_already_official': 'Workbench 已是官方状态',
    'apply.report.desc.workbench_overlay_degraded': '已启用，但编辑器未能安全确认；本次跳过浮层',
    'apply.report.desc.companion_extension': 'Claude 选区引用 CodeLens，{files}',
    'apply.report.overlay_degraded_heading': '⚠ 编辑器浮层本次未应用（其余设置已全部正常应用，你的配置未被改动）',
    'apply.report.overlay_degraded_reason_only_official_vscode': '当前 Claude Code 目标不是官方 VS Code Stable/Insiders，无法安全确认编辑器程序文件。',
    'apply.report.overlay_degraded_reason_workbench_not_found': '没有为该目标找到 VS Code Stable/Insiders 的 Workbench 程序文件。',
    'apply.report.overlay_degraded_reason_ambiguous_workbench': '找到了多个可能的 Workbench 程序文件，无法安全唯一选择。',
    'apply.report.overlay_degraded_reason_unknown': '无法为该目标安全唯一确认编辑器 Workbench。',
    'apply.report.overlay_degraded_reason_apply_error': '编辑器浮层应用失败，本次已跳过：',
    'apply.report.overlay_degraded_hint': '默认引用入口（companion 提供的 CodeLens）不受影响。要使用浮层，请在官方 VS Code Stable/Insiders 中运行 Claude Code；或在 Configure 关闭“编辑器浮层（引用文本或文件）”以消除此提示。',
    'apply.report.overlay_degraded_candidates': '候选：{list}',
    'apply.report.desc.system_fonts': '安装 IBM Plex Serif，{files}',
    'apply.report.desc.custom_icon_dir': '从 {name} 应用自定义图标，{files}',
    'apply.report.desc.custom_icon_slot': '已消毒的自定义图标字节',
    'apply.report.desc.custom_icon_official_slot': 'SVG 源不栅格化，保留官方 PNG',

    'restore.title':            '[恢复官方 Claude Code]',
    'restore.restore_root':     '恢复点根目录：{path}',
    'restore.workbench_restore_root':'Workbench 恢复点根目录：{path}',
    'restore.restore_point_dir':'恢复点：{dir}',
    'restore.workbench_restore_point_dir':'Workbench 恢复点：{dir}',
    'restore.cancelled':        '已取消。',
    'restore.confirm_official': '确认把这个 Claude Code 目标恢复为官方文件？(y/N)：',
    'restore.already_official': '这个 Claude Code 目标看起来已经是官方状态，无需恢复。',
    'restore.done':             '已还原 {restored} 个文件,跳过 {skipped} 个。',
    'restore.workbench_restored':'Workbench 编辑器浮层已恢复。',
    'restore.workbench_already_official':'Workbench 编辑器浮层已经是官方状态。',
    'restore.workbench_unsupported':'当前宿主未检查 Workbench 编辑器浮层。',
    'restore.companion_removed':'已移除 companion 扩展（{count} 个）。',
    'restore.companion_none':   '未找到已安装的 companion 扩展。',
    'restore.reload_hint':      '请在 VS Code 里执行 Developer: Reload Window 以生效。',

    // --- cleanup flow ---
    'cleanup.title':            '[清理旧版备份文件]',
    'cleanup.backup_root':      '旧版备份根目录：{path}',
    'cleanup.summary':          '{files} 个文件 / {dirs} 个目录 / {size}',
    'cleanup.none':             '未找到旧版备份文件。',
    'cleanup.confirm':          '确认删除该目录下所有旧版备份文件？(y/N)：',
    'cleanup.done':             '已删除旧版备份：{files} 个文件 / {dirs} 个目录 / {size}。',

    // --- update check ---
    'update.available':         '发现新版本：{current} → {latest}',
    'update.command':           '运行：npm install -g incipit@latest --prefer-online',
    'update.prompt':            '现在升级？[Y/n]：',
    'update.skipped':           '继续使用当前版本。',
    'update.upgrading':         '正在升级 incipit…',
    'update.upgrade_succeeded': '升级完成。请重新运行 incipit。',
    'update.upgrade_failed':    '升级失败。可手动执行：npm install -g incipit@latest --prefer-online',

    'picker.heading':           'Please choose your language  /  请选择语言',
    'picker.option_zh':         '中文',
    'picker.option_en':         'English',
    'picker.prompt':            '1 / 2 : ',
    'language.heading':         'CLI 界面语言',

    // --- target screen ---
    'target.heading':           '── 管理 Claude Code 目标位置 ──',
    'target.scanning':          '正在扫描 Claude Code 安装位置 ...',
    'target.no_targets':        '未检测到任何 Claude Code 安装。',
    'target.no_targets_hint':   '可使用下方"+ 添加新目标"手动指定。',
    'target.list_heading':      '已知目标',
    'target.add_label':         '+ 添加新目标 (文件夹对话框)',
    'target.scan_label':        '⌕ 深度扫描 (查找更多安装)',
    'target.remove_label':      '× 删除目标',
    'target.back':              '返回',
    'target.column_auto':       '自动',
    'target.column_manual':     '手动',
    'target.column_invalid':    '已失效',
    'target.confirm_remove':    '删除这个手动添加的目标？(y/N)：',
    'target.removed':           '已删除。',
    'target.added':             '已添加目标：{label}',
    'target.cannot_remove_auto':'自动探测到的项不能删除——请直接卸载对应的安装。',
    'target.no_manual_to_delete':'当前没有可删除的手动目标(自动探测项不能从这里删除)。',
    'target.delete_mode_heading':'请选择要删除的目标',
    'target.hint':              'a 添加 · s 扫描 · d 删除 · b 返回',
    'target.hint_delete':       '↑↓ 选择 · 回车 删除 · Esc 取消',

    // --- add target wizard ---
    'target.add.heading':       '── 添加 Claude Code 安装目标 ──',
    'target.add.intro':         '接下来会弹出系统{folder}选择对话框。请挑以下任意一种：',
    'target.add.intro_dialog_word': '文件夹',
    'target.add.option_a':      'VS Code 系宿主的 extensions 扩展目录',
    'target.add.option_a_egs':  '典型位置：~/.vscode/extensions',
    'target.add.option_a_egs2': '          ~/.cursor/extensions',
    'target.add.option_b':      'portable / Scoop 安装的 data 目录',
    'target.add.option_b_egs':  '典型位置：~/scoop/apps/vscode/current/data',
    'target.add.option_b_egs2': '          ~/scoop/persist/vscode/data 或 <解压目录>/data',
    'target.add.option_c':      '单个 anthropic.claude-code-X.Y.Z 子目录',
    'target.add.option_c_eg':   '(钉死某一个版本时用)',
    'target.add.proceed':       '打开文件夹对话框',
    'target.add.cancel':        '取消',
    'target.add.dialog_title':  '选择 VS Code 安装目录或扩展目录',
    'target.add.dialog_unavailable_title': '系统对话框不可用',
    'target.add.dialog_unavailable_no_display':
                                '当前环境检测不到图形界面 (DISPLAY / WAYLAND_DISPLAY 都未设置)。incipit 无法在 headless 主机上弹出文件夹对话框。',
    'target.add.dialog_unavailable_no_zk':
                                '系统中既没有 zenity 也没有 kdialog。请安装其中之一,或在带有图形界面的机器上运行 incipit。',
    'target.add.dialog_unavailable_other':
                                '当前平台无可用的图形文件夹选择器。',
    'target.add.dialog_failed': '文件夹对话框失败：{msg}',
    'target.add.cancelled':     '已取消。',

    // --- identify outcomes ---
    'target.identify.kind_extension_version':  '单个扩展版本目录',
    'target.identify.kind_extensions_dir':     '扩展根目录',
    'target.identify.kind_portable_data':      'portable data 目录',
    'target.identify.kind_portable_data_empty':'portable data 目录 (尚未装 Claude Code)',
    'target.identify.recognized':              '已识别',
    'target.identify.label_kind':              '类型',
    'target.identify.label_extensions':        '扩展目录',
    'target.identify.label_settings':          'settings.json',
    'target.identify.label_version':           '最高版本',
    'target.identify.prompt_label':            '给这个目标起一个名称(可选)：',
    'target.identify.save':                    '保存',
    'target.identify.repick':                  '重新选择',
    'target.identify.cancel':                  '取消',
    'target.identify.no_settings_inferred':    '(无法自动推断,首次 apply 时会再问一次)',
    'target.identify.empty_data_warn':         '此目录下尚未发现 anthropic.claude-code-* 扩展。目标会被保存,但在该目录下装上 Claude Code 之前 apply 会拒绝执行。',

    // --- identify failures ---
    'target.identify.fail_heading':            '无法识别这个文件夹',
    'target.identify.fail_picked':             '你选的是',
    'target.identify.fail_unknown':
        '这里不像 VS Code 系编辑器存放 Claude Code 的位置。请改选下列之一：\n' +
        '  · 编辑器的 数据/profile 目录，如  ~/.vscode  ~/.cursor  ~/.vscode-insiders\n' +
        '  · 它的 extensions/ 子目录\n' +
        '  · 单个 anthropic.claude-code-* 版本目录\n' +
        '  · portable 的 data/ 目录（里面有 extensions/ + user-data/）',
    'target.identify.fail_profile_no_claude':
        '这看着是 VS Code 系编辑器的 profile 目录，但它的 extensions/ 下\n' +
        '没有安装 Claude Code 扩展。请先在该编辑器里装上 Claude Code，或改选\n' +
        '真正装了 Claude Code 的那个编辑器的 profile / extensions 目录。',
    'target.identify.fail_standard_install':
        '你选的是 VS Code 系宿主的程序安装目录,但这台机器上它看起来走的是标准模式——\n' +
        '扩展和设置实际**不在**程序目录下,而是在系统标准的用户目录里。如果已经安装 Claude Code,\n' +
        '它应该会出现在自动探测列表里 (回到上一屏即可看到)。\n' +
        '\n' +
        '如果你想加的是 portable 或 Scoop 版,请确认它的安装目录里有 data/ 子文件夹\n' +
        '(里面同时有 data/extensions 和 data/user-data),然后选 data/ 那个文件夹,\n' +
        '不是程序根目录。',
    'target.identify.fail_repick':             '重新选择',
    'target.identify.fail_back':               '返回',
    'target.identify.fail_scan_here':          '⌕ 深度扫描这个目录',

    // --- 深度扫描 ---
    'target.scan.heading':            '── 深度扫描 Claude Code ──',
    'target.scan.progress_heading':   '扫描中…',
    'target.scan.stat':               '已扫 {dirs} 个目录 · 找到 {found} · {secs}s',
    'target.scan.scanning_empty':     '搜索中…(暂无新发现)',
    'target.scan.progress_hint':      '按任意键停止,并使用已找到的结果',
    'target.scan.results_heading':    '深度扫描结果',
    'target.scan.results_summary':    '第 {from}–{to} / 共 {count}',
    'target.scan.results_hint':       '↑↓ 移动   ·   PgUp/PgDn 翻页   ·   Home/End 首尾 — 只动列表',
    'target.scan.results_actions':    '[空格] 勾选    [↵] 添加所选（{n}）\n[a] 全选    [n] 全不选    [Esc] 取消',
    'target.scan.none_found':         '没有发现新的 Claude Code 安装(已知目标已隐藏)。',
    'target.scan.timed_out':          '已达时间上限——结果可能不全;想全扫请选更具体的目录',
    'target.scan.stopped':            '已停止',
    'target.scan.added':              '已添加 {n} 个目标。',
    'target.scan.added_none':         '未勾选——没有添加任何目标。',

    // --- apply pre-picker ---
    'target.apply_picker.heading':             '── 确认 apply 目标 ──',
    'target.apply_picker.use_label':           '使用此目标',
    'target.apply_picker.change_label':        '换一个目标',
    'target.apply_picker.cancel_label':        '取消',
    'target.apply_picker.no_active':
        '当前没有设定 active 目标。请先在主菜单里通过 "4. 目标 Claude Code 安装" 选一个。',

    // --- non-interactive apply / restore / list-targets ---
    'cli.no_targets_for_apply':
        '未检测到任何 Claude Code 安装。请先跑交互式 incipit 添加一个目标，或显式传 --extensions-dir。',
    'cli.no_targets_for_restore':
        '未检测到任何 Claude Code 安装，无法还原。请先跑交互式 incipit 添加一个目标，或显式传 --extensions-dir。',
    'cli.ambiguous_targets_heading':
        '检测到多个 Claude Code 安装，请明确指定:',
    'cli.ambiguous_targets_template_heading':
        '任选其一:',
    'cli.ambiguous_targets_or_list':
        '或:  incipit list-targets    # 查看完整候选',
    'cli.bad_extensions_dir_missing':
        '扩展目录不存在: {path}',
    'cli.bad_extensions_dir_not_dir':
        '扩展目录不是文件夹: {path}',
    'cli.bad_extensions_dir_no_cc':
        '该目录下没有 anthropic.claude-code-*: {path}',
    'cli.bad_settings_parent_missing':
        'settings-path 的父目录不存在: {path}\n  (通常意味着这台机器还没启动过对应的 VS Code)',
    'cli.list_targets_empty':
        '未检测到任何 Claude Code 安装。\n请跑交互式 incipit，用"+ 添加新目标"注册一个。',
    'cli.list_targets_lastused_marker':
        '上次用过',
    'cli.list_targets_kind_auto':
        '自动',
    'cli.list_targets_kind_manual':
        '手动',
    'cli.list_targets_label_extensions':
        'extensions',
    'cli.list_targets_label_settings':
        'settings',
    'cli.list_targets_label_version':
        'version',
    'cli.list_targets_invalid_marker':
        '已失效 (扩展目录缺失或无 Claude Code)',

    // --- configure menu ---
    'configure.heading':        '── 配置 ──',
    'configure.feature_math':   '数学公式渲染',
    'configure.feature_session':'会话用量',
    'configure.experimental':   '实验性',
    'configure.experimental_value_on':'1 项启用',
    'configure.experimental_value_off':'未启用',
    'configure.experimental_heading':'── 实验性 ──',
    'configure.feature_editor_overlay':'编辑器浮层（引用文本或文件）',
    'configure.experimental_overlay_desc_what':'选中代码后显示浮动按钮，插入 @file / @file#range。',
    'configure.experimental_overlay_desc_why':'实验性：会修改 VS Code 程序文件，相当于改 VS Code 源码，可能触发损坏提示。',
    'configure.experimental_overlay_desc_restore':'开关后需 Apply + Reload；关闭后 apply/restore 可还原。',
    'configure.param_body_size':'正文字号',
    'configure.reset':          '重置默认',
    'configure.back':           '返回',
    'configure.on':             '启用',
    'configure.off':            '关闭',
    'configure.reset_confirm':  '将功能开关和外观设置重置为默认？(y/N)：',
    'configure.reset_done':     '已重置。',
    'configure.saved_hint':     '已保存。重跑 1. 应用界面补丁 使更改生效。',
    'configure.body_size_heading':'正文字号',
    'configure.body_size_default_mark':'(默认)',
    'configure.param_palette':  '主题色',
    'configure.palette_heading':'主题色',
    'configure.palette_warm_black':'暖黑',
    'configure.palette_ink_black':'墨黑',
    'configure.palette_warm_white':'暖白',
    'configure.palette_warm_white_bold':'暖白（正文加粗）',
    'configure.param_body_font':  '正文字体',
    'configure.param_code_font':  '代码字体',
    'configure.param_icon':       '应用图标',
    'configure.icon_official':    '官方 Claude',
    'configure.icon_custom':      '自定义：{name}',
    'configure.icon_invalid':     '自定义设置无效',
    'configure.icon_missing':     '自定义文件已丢失',
    'configure.icon_heading':     '应用图标',
    'configure.icon_choose':      '选择 SVG 或透明背景 PNG…',
    'configure.icon_clear':       '清除自定义图标设置',
    'configure.icon_dialog_title':'选择 SVG 或透明背景 PNG 图标',
    'configure.icon_saved':       '已保存自定义图标：{name}',
    'configure.icon_cleared':     '已清除自定义图标设置。',
    'configure.icon_restore_hint':'若该图标已经应用到扩展，请再执行一次“恢复官方 Claude Code”，即可把磁盘上的官方图标还原。',
    'configure.icon_dialog_failed':'文件选择器失败：{msg}',
    'configure.icon_dialog_unavailable_no_powershell':'未找到 PowerShell，无法打开 Windows 文件选择器。',
    'configure.icon_dialog_unavailable_no_osascript':'未找到 osascript，无法打开 macOS 文件选择器。',
    'configure.icon_dialog_unavailable_no_display':'当前 Linux 会话没有可用的桌面显示，无法打开文件选择器。',
    'configure.icon_dialog_unavailable_no_zenity_no_kdialog':'请安装 zenity 或 kdialog 后再选择图标文件。',
    'configure.icon_error_opaque_png':'这个 PNG 没有任何真正透明的像素。请改用透明背景 PNG 或 SVG。',
    'configure.icon_error_svg':'出于安全原因拒绝了这个 SVG（{code}）。请移除脚本、事件属性、嵌入 HTML 与外部引用。',
    'configure.icon_error_png':'这个 PNG 格式异常或无法安全解码（{code}）。请重新导出为普通透明背景 PNG。',
    'configure.icon_error_source':'已保存的图标文件无法使用（{code}）。请重新选择。',
    'configure.icon_error_generic':'无法使用这个图标：{msg}',
    'configure.body_font_heading':'正文字体',
    'configure.code_font_heading':'代码字体',
    'configure.font_custom_prompt':'输入 CSS font-family（如 \'LXGW WenKai\', serif）：',
    'configure.font_custom_warning_body':'默认字体方案是 incipit 为长文阅读特别设计和优化的排版基线，包含字重、强调层与中英混排。',
    'configure.font_custom_warning_code':'自定义代码字体可能影响对齐、diff 和工具输出；出问题请恢复 Rec Mono Linear。',
    'configure.font_custom_label':'自定义',
    'configure.font_plex_hei':    'IBM Plex Serif + 思源黑体',
    'configure.font_plex_serif':  'IBM Plex Serif + 霞鹜文楷',
    'configure.font_rec_mono':    'Rec Mono Linear',
    'configure.font_jetbrains_mono':'JetBrains Mono',
    'configure.font_system_mono': '系统等宽体',
    'configure.font_custom':      '自定义',
    'apply.font_custom_value':    '自定义',

    // --- apply result summary ---
    'apply.summary_heading':    '当前配置',
    'apply.summary_on':         '启用',
    'apply.summary_off':        '关闭',
    'apply.summary_hint':       '提示：`3. 配置` 可调整，改动后重跑 `1. 应用界面补丁` 生效。',
  },
};

function setLocale(lang) {
  if (STRINGS[lang]) currentLocale = lang;
}

function getLocale() {
  return currentLocale;
}

// `vars` is an optional `{name: value}` map for `{name}` placeholder
// substitution. Missing keys fall through to English, then to the raw
// key string — the CLI must never crash on a missing translation.
function t(key, vars) {
  const table = STRINGS[currentLocale] || STRINGS[DEFAULT_LOCALE];
  const raw =
    (table && table[key]) ||
    (STRINGS[DEFAULT_LOCALE] && STRINGS[DEFAULT_LOCALE][key]) ||
    key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
  );
}

module.exports = { setLocale, getLocale, t };
