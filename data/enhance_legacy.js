import { ATTR, SEL, closestByAttr } from './host_probe.js';
import { CFG, assetURL, getActiveClaudeSessionId, locateClaudeConnection, log, reportHealth, warn, whenDOMReady } from './enhance_shared.js';
import { defineCapability } from './capability.js';
import { reactFiberForElement, reactFiberKeyForElement } from './capability/fingerprints/fiber.js';
import { initLegacyIdentity } from './legacy/identity.js';
import { initLegacyTranscriptActionDebug, initLegacyTranscriptActions } from './legacy/transcript_actions.js';
import { initLegacyToolFold } from './legacy/tool_fold.js';
import { initLegacyDiffIsland } from './legacy/diff_island.js';
import { initLegacyForkRewind } from './legacy/fork_rewind.js';
import { initLegacyUserBubble } from './legacy/user_bubble.js';
import { initLegacyDeferredNext } from './legacy/deferred_next.js';
import { initLegacyAskRefinement } from './legacy/ask_refinement.js';
import {
  conversationIsBusy as kernelConversationIsBusy,
  getHostState as kernelGetHostState,
  registerBusyProbe as registerRuntimeBusyProbe,
  subscribe as subscribeRuntime,
} from './runtime_kernel.js';

/**
 * Heavy interaction module for the patched Claude Code UI.
 *
 * Bootstrap handles first paint and split modules now own typography,
 * thinking, and footer/badge surfaces. This module keeps the remaining
 * interaction-heavy systems: transcript actions, local history edit/rerun,
 * tool folding, diff islands, and related host/fiber helpers.
 *
 * Math gating: the old host-class blocklist is gone. `preprocessMarkdownMath`
 * is only ever called from the patched `react-markdown` handoff, which
 * Claude Code uses exclusively for assistant messages. User bubbles bypass
 * it entirely, so their DOM text never receives the placeholder token and
 * `math_rewriter` leaves them alone. DOM-level protection still hard-blocks
 * live `contenteditable` subtrees and diff surfaces, where source text must
 * stay literal even if it contains markdown or TeX-looking syntax.
 */

(() => {
  'use strict';

  // Bilingual (EN/ZH, driven by CFG.language) copy for the scattered
  // interaction-surface strings owned directly by this module — dialogs,
  // tooltips, dropdown items, toasts. Mirrors enhance_footer_badge.js's
  // t()/STR pattern (named LEGACY_STR/legacyText here to avoid colliding
  // with the many local `t`/`T` variables already used as short-lived
  // transcript-text locals throughout this file). DEFERRED_NEXT_TEXT and
  // CHANGE_REVIEW_TEXT below are separate, longer-lived dictionaries with
  // their own accessors and stay that way.
  const LEGACY_STR = {
    en: {
      custom_model: 'Custom model',
      custom_model_id_description: 'Custom model ID',
      custom_model_enter_id: 'Enter a model ID.',
      custom_model_session_not_ready: 'The active Claude session is not ready yet.',
      custom_model_set_failed: 'Could not set model: {msg}',
      close: 'Close',
      model_id_label: 'Model ID',
      cancel: 'Cancel',
      use_model: 'Use model',
      use_custom_model_id_action: 'Use custom model ID...',
      set_model_by_full_id: 'Set a model by full ID',
      action_failed: 'Action failed',
      diff_fallback_title: 'diff',
      preview_image: 'Preview image',
      click_to_preview: 'Click to preview',
      image_fallback_label: 'image',
      remove_attachment: 'Remove attachment',
      ide_auto_attached_file: 'IDE auto-attached: opened file',
      ide_auto_attached_selection: 'IDE auto-attached: line selection',
      attached_reference: 'Attached reference (preserved across edit)',
      close_preview: 'Close preview',
      attach_image_hint: 'Attach image (paste or drop also works)',
      attach_image: 'Attach image',
      cancel_edit_esc: 'Cancel edit (Esc)',
      save_ctrl_enter: 'Save (Ctrl+Enter)',
      save_rerun_ctrl_enter: 'Save and rerun (Ctrl+Enter)',
      copy_as_text: 'Copy as text',
      copy_as_markdown: 'Copy as markdown',
      rerun_with_code_rewind: 'Rerun with code rewind',
      fork_with_code_rewind: 'Fork with code rewind',
      rewind_code_only: 'Rewind code only',
      disabled_while_streaming: 'Disabled while streaming',
      cannot_fork_first_message: 'Cannot fork from the first message',
      edit_user_message: 'Edit user message (local history only)',
      edit_assistant_message: 'Edit AI output (local history only)',
      rerun_this_turn: 'Rerun this turn',
      fork_conversation_from_here: 'Fork conversation from here',
      more_actions: 'More actions',
      show_more: 'Show more',
      show_less: 'Show less',
      permission_request_fallback: 'Permission request',
      expand_permission_panel: 'Expand permission panel',
      collapse_permission_panel: 'Collapse permission panel',
      expand: 'Expand',
      collapse: 'Collapse',
      close_diff: 'Close diff',
      click_to_expand: 'Click to expand',
      open: 'Open',
      could_not_copy_absolute_path: 'Could not copy absolute path',
      could_not_copy_relative_path: 'Could not copy relative path',
      open_in_file_explorer: 'Open in File Explorer',
      could_not_open_in_file_explorer: 'Could not open in file explorer',
      copy_relative_path: 'Copy Relative Path',
      copy_absolute_path: 'Copy Absolute Path',
      wait_for_reply_before_saving: 'Wait for the current reply to finish before saving',
      stream_not_idle_blocked: 'incipit cannot confirm the reply stream is idle; action blocked to protect the conversation.',
      local_history_updated_refresh: 'Local history updated. Refresh the window so the model sees the new content.',
      rerun_in_progress: 'A rerun is already in progress; let it finish first',
      no_content_to_rerun: 'No content to rerun',
      rerun_internal_no_session: 'Internal: cannot resolve active session id; rerun aborted to avoid writing the wrong transcript.',
      rerun_internal_no_send: 'Internal: cannot reach session.send; rerun aborted (local history is unchanged).',
      rerun_internal_no_selection: 'Internal: cannot reach session.selection; rerun aborted to avoid dropping the IDE reference.',
      rerun_previous_not_stopped: 'The previous reply has not finished stopping yet — nothing was changed. Wait for it to settle, then rerun again.',
      rerun_failed_fallback: 'Rerun failed',
      rerun_held_back_advanced: 'a background task or the interrupted reply appended after the cut',
      rerun_held_back_not_stopped: 'the previous turn did not finish stopping in time',
      rerun_held_back_wrap: 'Rerun was held back because {why}. Local history was restored — wait for the current reply to finish, then rerun again.',
      rerun_send_failed_restored: 'Rerun send failed; local history was restored: {msg}',
      rerun_send_failed_after_append: 'Rerun send failed after a new transcript append started: {msg}',
      rerun_send_failed_rollback_failed: 'Rerun send failed, and rollback failed: {msg}',
      rerun_send_failed: 'Rerun send failed: {msg}',
      rewind_no_checkpoint: 'Cannot rewind: no checkpoint anchor on this message',
      rewind_internal_no_rewindcode: 'Internal: cannot reach session.rewindCode; rewind aborted (no files were touched).',
      rewind_failed_msg: 'Rewind code failed: {msg}',
      rewind_failed: 'Rewind code failed',
      fork_internal_no_forkconversation: 'Internal: cannot reach context.forkConversation; fork aborted.',
      fork_internal_no_session: 'Internal: cannot resolve current session id; fork aborted.',
      fork_no_text_content: 'No text content to fork with',
      fork_failed: 'Fork failed: {msg}',
      attach_bad_type_detail: 'Only PNG, JPEG, GIF, and WebP images can be attached (got {type})',
      attach_too_large_detail: 'Image too large: {size} MB (max 5 MB)',
      image_encode_failed: 'Failed to encode image (unexpected reader output)',
      image_read_failed: 'Failed to read image file',
      nothing_to_rerun_hint: 'Nothing to rerun — type something or keep at least one image attachment.',
      nothing_to_save_hint: 'Nothing to save — type something or keep at least one attachment.',
      local_history_syncing: 'Local history is still syncing this assistant message; try again in a moment.',
      grep_in_label: 'IN',
      grep_out_label: 'OUT',
      transcript_mutation_failed_fallback: 'Transcript mutation failed',
      wait_for_reply_before_history_edit: 'Wait for the current reply to finish before editing local history.',
      cannot_confirm_idle_history_blocked: 'incipit cannot confirm the conversation is idle (host probes unavailable); local-history edit blocked.',
      webview_channel_unreachable: 'Could not reach the VS Code webview channel.',
      local_history_write_timed_out: 'Local history write request timed out.',
    },
    zh: {
      custom_model: '自定义模型',
      custom_model_id_description: '自定义模型 ID',
      custom_model_enter_id: '请输入模型 ID。',
      custom_model_session_not_ready: '当前 Claude 会话尚未就绪。',
      custom_model_set_failed: '无法设置模型：{msg}',
      close: '关闭',
      model_id_label: '模型 ID',
      cancel: '取消',
      use_model: '使用该模型',
      use_custom_model_id_action: '使用自定义模型 ID…',
      set_model_by_full_id: '通过完整 ID 设置模型',
      action_failed: '操作失败',
      diff_fallback_title: '差异',
      preview_image: '预览图片',
      click_to_preview: '点击预览',
      image_fallback_label: '图片',
      remove_attachment: '移除附件',
      ide_auto_attached_file: 'IDE 自动附加：已打开的文件',
      ide_auto_attached_selection: 'IDE 自动附加：选中的行',
      attached_reference: '已附加引用（编辑后仍保留）',
      close_preview: '关闭预览',
      attach_image_hint: '添加图片（也可粘贴或拖放）',
      attach_image: '添加图片',
      cancel_edit_esc: '取消编辑（Esc）',
      save_ctrl_enter: '保存（Ctrl+Enter）',
      save_rerun_ctrl_enter: '保存并重新运行（Ctrl+Enter）',
      copy_as_text: '复制为文本',
      copy_as_markdown: '复制为 Markdown',
      rerun_with_code_rewind: '带代码回退重新运行',
      fork_with_code_rewind: '带代码回退分叉',
      rewind_code_only: '仅回退代码',
      disabled_while_streaming: '流式输出期间不可用',
      cannot_fork_first_message: '无法从第一条消息分叉',
      edit_user_message: '编辑用户消息（仅本地历史）',
      edit_assistant_message: '编辑 AI 输出（仅本地历史）',
      rerun_this_turn: '重新运行本轮',
      fork_conversation_from_here: '从此处分叉对话',
      more_actions: '更多操作',
      show_more: '展开',
      show_less: '收起',
      permission_request_fallback: '权限请求',
      expand_permission_panel: '展开权限面板',
      collapse_permission_panel: '收起权限面板',
      expand: '展开',
      collapse: '收起',
      close_diff: '关闭差异',
      click_to_expand: '点击展开',
      open: '打开',
      could_not_copy_absolute_path: '无法复制绝对路径',
      could_not_copy_relative_path: '无法复制相对路径',
      open_in_file_explorer: '在文件资源管理器中打开',
      could_not_open_in_file_explorer: '无法在文件资源管理器中打开',
      copy_relative_path: '复制相对路径',
      copy_absolute_path: '复制绝对路径',
      wait_for_reply_before_saving: '请等待当前回复结束后再保存',
      stream_not_idle_blocked: 'incipit 无法确认回复流已空闲；为保护对话，该操作已被阻止。',
      local_history_updated_refresh: '本地历史已更新。请刷新窗口，以便模型看到新内容。',
      rerun_in_progress: '已有一个重新运行正在进行，请先等待其完成',
      no_content_to_rerun: '没有可重新运行的内容',
      rerun_internal_no_session: '内部错误：无法确定当前会话 ID；为避免写入错误的记录，重新运行已中止。',
      rerun_internal_no_send: '内部错误：无法访问 session.send；重新运行已中止（本地历史未改变）。',
      rerun_internal_no_selection: '内部错误：无法访问 session.selection；为避免丢失 IDE 引用，重新运行已中止。',
      rerun_previous_not_stopped: '上一条回复尚未完全停止 — 未做任何更改。请等待其稳定后再重新运行。',
      rerun_failed_fallback: '重新运行失败',
      rerun_held_back_advanced: '有后台任务或被中断的回复在截断点之后追加了内容',
      rerun_held_back_not_stopped: '上一轮尚未在预期时间内停止',
      rerun_held_back_wrap: '重新运行已被暂缓，因为{why}。本地历史已恢复 — 请等待当前回复结束后再重新运行。',
      rerun_send_failed_restored: '重新运行发送失败；本地历史已恢复：{msg}',
      rerun_send_failed_after_append: '重新运行发送失败，此时已有新的记录开始追加：{msg}',
      rerun_send_failed_rollback_failed: '重新运行发送失败，且回滚也失败：{msg}',
      rerun_send_failed: '重新运行发送失败：{msg}',
      rewind_no_checkpoint: '无法回退：此消息没有检查点锚点',
      rewind_internal_no_rewindcode: '内部错误：无法访问 session.rewindCode；回退已中止（未修改任何文件）。',
      rewind_failed_msg: '代码回退失败：{msg}',
      rewind_failed: '代码回退失败',
      fork_internal_no_forkconversation: '内部错误：无法访问 context.forkConversation；分叉已中止。',
      fork_internal_no_session: '内部错误：无法确定当前会话 ID；分叉已中止。',
      fork_no_text_content: '没有可用于分叉的文本内容',
      fork_failed: '分叉失败：{msg}',
      attach_bad_type_detail: '仅支持添加 PNG、JPEG、GIF 和 WebP 格式的图片（实际为 {type}）',
      attach_too_large_detail: '图片过大：{size} MB（最大 5 MB）',
      image_encode_failed: '图片编码失败（读取结果异常）',
      image_read_failed: '读取图片文件失败',
      nothing_to_rerun_hint: '没有可重新运行的内容 — 请输入文字，或保留至少一张图片附件。',
      nothing_to_save_hint: '没有可保存的内容 — 请输入文字，或保留至少一个附件。',
      local_history_syncing: '本地历史仍在同步此助手消息；请稍后重试。',
      grep_in_label: '输入',
      grep_out_label: '输出',
      transcript_mutation_failed_fallback: '记录修改失败',
      wait_for_reply_before_history_edit: '请等待当前回复结束后再编辑本地历史。',
      cannot_confirm_idle_history_blocked: 'incipit 无法确认对话已空闲（主机探测不可用）；本地历史编辑已被阻止。',
      webview_channel_unreachable: '无法连接到 VS Code webview 通道。',
      local_history_write_timed_out: '本地历史写入请求超时。',
    },
  };

  function legacyText(key, vars) {
    const dict = LEGACY_STR[CFG.language] || LEGACY_STR.en;
    let raw = (dict && dict[key]) || LEGACY_STR.en[key] || key;
    if (vars && typeof vars === 'object') {
      for (const name of Object.keys(vars)) {
        raw = raw.replace(new RegExp('\\{' + name + '\\}', 'g'), String(vars[name]));
      }
    }
    return raw;
  }

  // Bootstrap/shared owns config, logging, host probing, styles, app vars,
  // body-bold, DOM freeze, and DOM-ready scheduling. The legacy module now
  // only owns the interaction-heavy surfaces that have not been split yet.

  // ========== 1. asset-loader ==========

  const effortBrainPreloadImages = [];
  let effortBrainPreloadStarted = false;

  function preloadEffortBrainIcons() {
    if (effortBrainPreloadStarted) return;
    effortBrainPreloadStarted = true;

    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    // CSS swaps external SVG background-images on every effort change. Without
    // an explicit warm-up, the first visit to a level can briefly paint an
    // empty `::before` while Chromium loads/decodes that SVG. Preload both ink
    // sets: the inactive set is tiny, and this also covers the short moment
    // before warm-white overrides replace the dark defaults.
    const files = [];
    for (const level of levels) {
      files.push('effort-brain/effort-brain-' + level + '-white.svg');
      files.push('effort-brain/effort-brain-' + level + '.svg');
    }

    for (const file of files) {
      const href = assetURL(file);
      const id = 'incipit-preload-' + file.replace(/[^a-z0-9_-]+/gi, '-');
      if (!document.getElementById(id)) {
        const link = document.createElement('link');
        link.id = id;
        link.rel = 'preload';
        link.as = 'image';
        link.href = href;
        document.head.appendChild(link);
      }

      const img = new Image();
      img.decoding = 'async';
      img.src = href;
      effortBrainPreloadImages.push(img);
      if (typeof img.decode === 'function') {
        img.decode().catch(() => { /* CSS background can still use the URL. */ });
      }
    }
  }

  // Typography, math rendering, CJK punctuation, and code highlighting moved to enhance_typography.js.

  // ========== 8. user-copy ==========
  //
  // Only user message bubbles get a copy button. Assistant replies and tool
  // output are intentionally left alone because reconstructing source text
  // from their DOM is much less reliable.
  //
  // The button lives in a transparent sibling row on the host container so
  // bubble padding stays compact.

  // Outline SVG icons that inherit `currentColor`.
  const COPY_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' +
    '</svg>';
  const CHECK_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"/>' +
    '</svg>';
  const EDIT_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
    '</svg>';
  // Reprise arrow (rerun this turn): a quiet single-stroke loop that reads
  // as rerun without sharing the edit pencil's writing-tool metaphor.
  // Lives only on user bubbles. Live state takes terra orange via CSS;
  // disabled state is just a colour + opacity shift (no slash overlay) —
  // rerun is a single primitive action, not a slash-able verb like edit/delete.
  const RERUN_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18.35 7.35c-2.44-2.72-6.7-3-9.48-.56C5.9 9.4 5.8 14 8.66 16.76c2.65 2.56 6.88 2.52 9.45-.1 1.22-1.24 1.88-2.89 1.84-4.58"/>' +
    '<path d="M18.35 7.35l-.56-3.58"/>' +
    '<path d="M18.35 7.35l-3.6.48"/>' +
    '</svg>';
  // More (vertical three dots): opens a dropdown listing copy variants.
  const MORE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="5.5" r="1.6"/>' +
    '<circle cx="12" cy="12" r="1.6"/>' +
    '<circle cx="12" cy="18.5" r="1.6"/>' +
    '</svg>';
  const GUIDE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M19 12H5"/>' +
    '<path d="M12 5l-7 7 7 7"/>' +
    '</svg>';
  const TRASH_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/>' +
    '<path d="M8 6V4h8v2"/>' +
    '<path d="M19 6l-1 14H6L5 6"/>' +
    '<path d="M10 11v5"/>' +
    '<path d="M14 11v5"/>' +
    '</svg>';
  // Fork (git-branch Y): main button on user bubbles, also reused inside
  // the More dropdown for "Fork with code rewind". Lucide git-branch
  // shape — vertical trunk + side node + arc — reads as "branch out"
  // rather than "fork into pieces". Different metaphor from rerun's
  // closed loop, so the two main buttons stay visually distinct.
  const FORK_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="6" y1="3" x2="6" y2="15"/>' +
    '<circle cx="18" cy="6" r="3"/>' +
    '<circle cx="6" cy="18" r="3"/>' +
    '<path d="M18 9a9 9 0 0 1-9 9"/>' +
    '</svg>';
  // Pure rewind (Lucide rotate-ccw): full-size icon used by "Rewind code
  // only" in the More dropdown. Arrow nub at top-LEFT, deliberately
  // mirrored from RERUN_ICON_SVG (arrow at top-RIGHT) so a 16px slot can
  // tell them apart even without reading the label.
  const REWIND_ONLY_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 3.5-7.1L3 8"/>' +
    '<polyline points="3 3 3 8 8 8"/>' +
    '</svg>';
  const COPY_AS_TEXT_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 7h14"/>' +
    '<path d="M5 12h14"/>' +
    '<path d="M5 17h9"/>' +
    '</svg>';
  const COPY_AS_MARKDOWN_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m8 8-4 4 4 4"/>' +
    '<path d="m16 8 4 4-4 4"/>' +
    '<path d="m14 6-4 12"/>' +
    '</svg>';
  const FOLDER_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' +
    '</svg>';
  // Streaming-disabled variant for edit: original artwork + a single
  // top-left → bottom-right slash painted last so it sits above the
  // icon body. Direction perpendicular to the pen (which runs
  // upper-right → lower-left); a parallel slash would just read as a
  // thicker pen. Stroke a hair thicker than 1.75 so the cancel mark
  // reads at a glance; currentColor follows the disabled foreground.
  const EDIT_ICON_DISABLED_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/>' +
    '<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
    '<line x1="3.5" y1="3.5" x2="20.5" y2="20.5" stroke-width="2"/>' +
    '</svg>';

  // Inline-edit action icons. Two SVGs replace the three (copy/edit/
  // delete) while editing, matching their stroke style so the row
  // reads as the same family. Cancel = X mark; save = checkmark.
  const CANCEL_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '</svg>';
  const SAVE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="5 12 10 17 19 7"/>' +
    '</svg>';
  // Inline editor chip strip icons. Document/file glyph for ide_*
  // refs; small × for chip remove; plus for the add-image affordance.
  // All `currentColor` so warm-white override only swaps the chip's
  // text colour, not the geometry.
  const CHIP_FILE_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 3 H7 A2 2 0 0 0 5 5 V19 A2 2 0 0 0 7 21 H17 A2 2 0 0 0 19 19 V8 Z"/>' +
    '<path d="M14 3 V8 H19"/>' +
    '</svg>';
  const CHIP_X_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="7" y1="7" x2="17" y2="17"/>' +
    '<line x1="17" y1="7" x2="7" y2="17"/>' +
    '</svg>';
  const CHIP_PLUS_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="12" y1="6" x2="12" y2="18"/>' +
    '<line x1="6" y1="12" x2="18" y2="12"/>' +
    '</svg>';

  let transcriptMutationSeq = 0;
  let transcriptMutationListenerBound = false;
  const transcriptMutationPending = new Map();

  function flashCopied(btn) {
    if (!btn) return;
    // Restore to whatever the button's resting icon is (rerun / more
    // / copy / etc), not the global copy icon. Fall back to current
    // innerHTML for buttons that pre-date the live-icon stash.
    const restore = btn._incipitLiveIcon || btn.innerHTML || COPY_ICON_SVG;
    btn.innerHTML = CHECK_ICON_SVG;
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = restore;
      btn.classList.remove('copied');
    }, 1200);
  }

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) flashCopied(btn);
    } catch (err) {
      warn('Copy failed:', err);
    }
  }

  // Markdown → readable plain text. Drops inline marks (`#`, `**`,
  // backticks, link URLs) but preserves structure (paragraph breaks,
  // list indentation, code body). Distinct from `textContent` which
  // collapses indentation and drops list markers entirely.
  function markdownToPlainText(md) {
    if (!md) return '';
    let text = String(md);
    // Fenced code blocks: keep body, drop fences and language tag.
    text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g, '$1');
    text = text.replace(/```([\s\S]*?)```/g, '$1');
    // Inline code: keep content, drop backticks.
    text = text.replace(/`([^`\n]+)`/g, '$1');
    // ATX headings: drop leading hashes (and trailing hashes).
    text = text.replace(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/gm, '$1');
    // Setext headings: drop the underline.
    text = text.replace(/^([^\n]+)\n[=-]{3,}\s*$/gm, '$1');
    // Images first (so the alt-text-only form survives the link pass).
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Links: keep label, drop URL.
    text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Reference-style links: keep label.
    text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
    // Bold + italic combinations (handle longer markers first).
    text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
    text = text.replace(/___([^_\n]+)___/g, '$1');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    text = text.replace(/__([^_\n]+)__/g, '$1');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
    text = text.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');
    // Strikethrough.
    text = text.replace(/~~([^~\n]+)~~/g, '$1');
    // Blockquotes: drop leading > markers (keep indent).
    text = text.replace(/^(\s*)>\s?/gm, '$1');
    // Unordered list markers → "- " (consistent indent-friendly form).
    text = text.replace(/^(\s*)[*+\-]\s+/gm, '$1- ');
    // Horizontal rules → blank line.
    text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');
    // Tables: drop separator rows (|---|---|), keep cell text but
    // collapse pipes to tabs for readability.
    text = text.replace(/^[ \t]*\|?[ \t]*[-:|][-:|\s]*\|?[ \t]*$/gm, '');
    text = text.replace(/\|/g, '\t');
    // Collapse 3+ blank lines down to 2.
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  // Body-portal dropdown anchored to a button. Closes on outside click
  // or Esc. Items: { label, icon, onClick } array. Returns the popup node.
  // Style hooks live in theme.css under `[data-incipit-action-dropdown]`
  // and pick up the selected palette through its active override stylesheet.
  function openActionDropdown(anchorBtn, items) {
    // Toggle behaviour: clicking the same anchor that already owns an
    // open dropdown closes it. We tag the popup with its anchor so we
    // can distinguish "clicked the anchor again" (close, don't reopen)
    // from "clicked a different anchor" (close old, open new).
    const existing = document.querySelector('[data-incipit-action-dropdown]');
    if (existing) {
      const wasForThisAnchor = existing._incipitAnchor === anchorBtn;
      existing.remove();
      if (existing._incipitAnchor) existing._incipitAnchor._incipitDropdownOpen = false;
      if (wasForThisAnchor) return null;
    }

    const popup = document.createElement('div');
    popup.setAttribute('data-incipit-action-dropdown', '');
    popup._incipitAnchor = anchorBtn;
    if (anchorBtn) anchorBtn._incipitDropdownOpen = true;
    for (const item of items) {
      // Separators are 1px rules — purely visual grouping (rewind block
      // above, copy block below, etc). No click handlers.
      if (item && item.type === 'separator') {
        const sep = document.createElement('div');
        sep.setAttribute('data-incipit-action-dropdown-separator', '');
        popup.appendChild(sep);
        continue;
      }
      const row = document.createElement('button');
      row.setAttribute('data-incipit-action-dropdown-item', '');
      row.type = 'button';
      // Disabled items render dimmed and swallow the click silently.
      // We snapshot disabled state at dropdown-open time; if state
      // flips while the popup is open, that's tolerable (the popup is
      // ephemeral — close + reopen and it picks up the new state).
      const isDisabled = !!item.disabled;
      if (isDisabled) {
        row.dataset.incipitDisabled = '1';
        row.setAttribute('aria-disabled', 'true');
      }
      if (item.title) row.title = item.title;
      if (item.icon) {
        const icon = document.createElement('span');
        icon.setAttribute('data-incipit-action-dropdown-icon', '');
        icon.innerHTML = item.icon;
        row.appendChild(icon);
      }
      const label = document.createElement('span');
      label.setAttribute('data-incipit-action-dropdown-label', '');
      label.textContent = item.label;
      row.appendChild(label);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (isDisabled) return;
        try { item.onClick(); } catch (error) { warn('dropdown action failed:', error); }
        close();
      });
      popup.appendChild(row);
    }

    document.body.appendChild(popup);

    // Position. We measure after append so getBoundingClientRect knows
    // popup's natural width. Default: below + right-aligned to the
    // anchor; flip up if there isn't room below.
    const anchorRect = anchorBtn.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    let top = anchorRect.bottom + 4;
    let left = anchorRect.right - popupRect.width;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left < 8) left = 8;
    if (left + popupRect.width > vw - 8) left = vw - 8 - popupRect.width;
    if (top + popupRect.height > vh - 8) top = anchorRect.top - 4 - popupRect.height;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      popup.remove();
      if (anchorBtn) anchorBtn._incipitDropdownOpen = false;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    }
    function onDocDown(e) {
      if (popup.contains(e.target)) return;
      // Click on the anchor: let the click handler reach openActionDropdown
      // again, which detects the same-anchor case and closes there. If we
      // closed here, click would re-open immediately (flicker).
      if (anchorBtn === e.target || (anchorBtn.contains && anchorBtn.contains(e.target))) return;
      close();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }
    // Defer listener bind to next tick so the click that opened us
    // doesn't immediately close us.
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', close);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
    }, 0);

    return popup;
  }

  function transcriptContent(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.message && typeof record.message === 'object' && 'content' in record.message) {
      return record.message.content;
    }
    if ('content' in record) return record.content;
    return null;
  }

  function unwrapTranscriptContentBlock(block) {
    if (block && typeof block === 'object' &&
        block.content && typeof block.content === 'object' &&
        typeof block.content.type === 'string') {
      return block.content;
    }
    return block;
  }

  // Classify a user record's content blocks for the rich inline editor.
  // Returns { chips, proseText, hadArrayContent }. Walks the SY array
  // (or wraps a string into a single-prose record), separates blocks
  // into:
  //   - "kept" chips (preserved across edit, individually removable):
  //       * ide_opened_file / ide_selection  (auto-attached file refs)
  //       * image                            (base64 image attachments)
  //   - prose text (the user's own typed message; multiple text blocks
  //     get joined with '\n' for the textarea, edited as one)
  //
  // Each chip carries its original index in `record.content`; on save
  // we send `{kind:'keep', index}` rather than re-uploading the whole
  // block (saves 100KB+ per image payload).
  //
  // Tag detection uses leading-tag regex against ide-host's actual
  // wording. Bare-tag fallback covers phrasing drift in future Claude
  // Code releases without inventing block types.
  function classifyUserRecordBlocks(record) {
    const out = { chips: [], proseText: '', hadArrayContent: false };
    if (!record) return out;
    const content = transcriptContent(record);
    if (typeof content === 'string') {
      out.proseText = content;
      return out;
    }
    if (!Array.isArray(content)) return out;
    out.hadArrayContent = true;

    const proseParts = [];
    let chipSeq = 0;
    for (let i = 0; i < content.length; i++) {
      const block = unwrapTranscriptContentBlock(content[i]);
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        const meta = parseIdeRefText(block.text);
        if (meta) {
          out.chips.push({
            chipId: 'k-' + (++chipSeq),
            kind: 'keep',
            index: i,
            blockKind: meta.kind,
            label: meta.label,
            subLabel: meta.subLabel || null,
            rawText: block.text,
          });
        } else {
          proseParts.push(block.text);
        }
      } else if (block.type === 'image' && block.source) {
        const src = block.source;
        let dataUrl = null;
        if (src.type === 'base64' &&
            typeof src.data === 'string' &&
            typeof src.media_type === 'string') {
          dataUrl = `data:${src.media_type};base64,${src.data}`;
        }
        out.chips.push({
          chipId: 'k-' + (++chipSeq),
          kind: 'keep',
          index: i,
          blockKind: 'image',
          mediaType: src.media_type || 'image/*',
          dataUrl,
        });
      }
      // Unknown / unrecognised block types are silently dropped from
      // the editor view; they're already non-editable from the user's
      // POV and forwarding an opaque blob would mislead the chip strip.
    }
    out.proseText = proseParts.join('\n');
    return out;
  }

  // Recognise Claude Code's IDE-attached text wrappers. The host wraps
  // an opened-file or line-selection notice as its own text block,
  // prefixed with these literal phrases (verified against 154 + 18
  // occurrences across 105 local sessions). We extract the file
  // basename (and line range for selections) for the chip label; the
  // raw text is kept on the chip descriptor so save's keep-by-index
  // round-trips it byte-perfect to the model.
  function parseIdeRefText(text) {
    const opened = /^\s*<ide_opened_file>The user opened the file ([\s\S]+?) in the IDE\./.exec(text);
    if (opened) {
      return { kind: 'ide_opened_file', label: basenameFromPath(opened[1]), subLabel: null };
    }
    const selection = /^\s*<ide_selection>The user selected the lines (\d+) to (\d+) from ([\s\S]+?):/.exec(text);
    if (selection) {
      const start = parseInt(selection[1], 10);
      const end = parseInt(selection[2], 10);
      const path = selection[3];
      return {
        kind: 'ide_selection',
        label: basenameFromPath(path),
        subLabel: start === end ? `L${start}` : `L${start}–${end}`,
      };
    }
    // Phrasing-drift fallback: catch other future <ide_*> tags so they
    // still surface as a chip rather than getting merged into the prose
    // textarea (which would look like raw XML to the user).
    const tagOnly = /^\s*<(ide_[a-z_]+)\b/.exec(text);
    if (tagOnly) {
      return { kind: tagOnly[1], label: '(ref)', subLabel: null };
    }
    return null;
  }

  function basenameFromPath(p) {
    if (!p) return '';
    const m = String(p).match(/[^\\/]+$/);
    return m ? m[0] : String(p);
  }

  // Parse a saved IDE-attached text block into a selection-shaped object
  // that `session.send(text, attachments, includeSelection)` can rebuild
  // into the same `<ide_*>` text via `zB1`. Differs from
  // parseIdeRefText (which keeps only chip-display fields) by capturing
  // the FULL filePath and selectedText, so on rerun the resulting
  // model-visible content is byte-equivalent to the saved record.
  //
  // Format reference (verbatim from host bundle index.js zB1):
  //   <ide_selection>The user selected the lines N to M from PATH: TEXT
  //     This may or may not be related to the current task.</ide_selection>
  //   <ide_opened_file>The user opened the file PATH in the IDE.
  //     This may or may not be related to the current task.</ide_opened_file>
  function parseIdeRefForSend(text) {
    if (typeof text !== 'string') return null;
    const sel = /^\s*<ide_selection>The user selected the lines (\d+) to (\d+) from ([\s\S]+?): ([\s\S]*?) This may or may not be related to the current task\.\s*<\/ide_selection>\s*$/.exec(text);
    if (sel) {
      return {
        kind: 'ide_selection',
        filePath: sel[3],
        selectedText: sel[4],
        startLine: parseInt(sel[1], 10),
        endLine: parseInt(sel[2], 10),
      };
    }
    const open = /^\s*<ide_opened_file>The user opened the file ([\s\S]+?) in the IDE\.\s*This may or may not be related to the current task\.\s*<\/ide_opened_file>\s*$/.exec(text);
    if (open) {
      return {
        kind: 'ide_opened_file',
        filePath: open[1],
        selectedText: '',
        startLine: 0,
        endLine: 0,
      };
    }
    return null;
  }

  // Walk a user record's content and pull out the first `<ide_*>` ref.
  // Used by rerun to pre-poke `session.selection.value` so the host's
  // own send pipeline rebuilds the exact ref text the saved record had.
  // At most one `<ide_*>` per user message in practice (zB1 only emits
  // one) so first-hit is correct.
  function extractSavedIdeRef(record) {
    const content = transcriptContent(record);
    if (!Array.isArray(content)) return null;
    for (const item of content) {
      const block = unwrapTranscriptContentBlock(item);
      if (!block || block.type !== 'text') continue;
      const ref = parseIdeRefForSend(block.text);
      if (ref) return ref;
    }
    return null;
  }

  // Convert a saved `{type:'image', source:{type:'base64', media_type, data}}`
  // block back into a composer-shaped attachment `{file: File, dataUrl}`,
  // which is what `session.send`'s second arg expects (see host bundle
  // `vx`/`zB1`). Returns null for non-base64 sources we can't replay
  // (e.g. URL-source images, which Anthropic doesn't accept anyway).
  //
  // The filename is synthesized from media_type since the saved block
  // carries no filename. The host's downstream code (zB1) reads only
  // dataUrl + file.name + file.type for image classification.
  function imageBlockToAttachment(block) {
    if (!block || block.type !== 'image' || !block.source) return null;
    const src = block.source;
    if (src.type !== 'base64' || typeof src.data !== 'string' ||
        typeof src.media_type !== 'string') return null;
    let bytes;
    try {
      const bin = atob(src.data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (_) { return null; }
    const ext = (src.media_type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    const name = `image.${ext}`;
    let file;
    try {
      file = new File([bytes], name, { type: src.media_type });
    } catch (_) { return null; }
    const dataUrl = `data:${src.media_type};base64,${src.data}`;
    return { file, dataUrl };
  }

  function imageSourceToAttachment(source) {
    return imageBlockToAttachment({ type: 'image', source });
  }

  function keptImageChipToAttachment(record, chip) {
    if (!record || !chip || chip.blockKind !== 'image') return null;
    if (!Number.isInteger(chip.index) || chip.index < 0) return null;
    const content = transcriptContent(record);
    if (!Array.isArray(content) || chip.index >= content.length) return null;
    const block = unwrapTranscriptContentBlock(content[chip.index]);
    return imageBlockToAttachment(block);
  }

  function savedIdeRefFromEditChips(chips) {
    if (!Array.isArray(chips)) return null;
    for (const chip of chips) {
      if (!chip || chip.kind !== 'keep') continue;
      if (typeof chip.rawText !== 'string') continue;
      const ref = parseIdeRefForSend(chip.rawText);
      if (ref) return ref;
    }
    return null;
  }

  function buildRerunPayloadFromEditorDraft(record, text, chips) {
    const attachments = [];
    for (const chip of (Array.isArray(chips) ? chips : [])) {
      if (!chip) continue;
      let att = null;
      if (chip.kind === 'keep' && chip.blockKind === 'image') {
        att = keptImageChipToAttachment(record, chip);
      } else if (chip.kind === 'image-new' && chip.source) {
        att = imageSourceToAttachment(chip.source);
      }
      if (att) attachments.push(att);
    }
    return {
      prose: typeof text === 'string' ? text : '',
      attachments,
      savedIdeRef: savedIdeRefFromEditChips(chips),
    };
  }

  // Build the full rerun payload (prose, attachments, savedIdeRef) from
  // a saved user record. Used by rerunFromUser. Mirrors the data model
  // the chip strip + textarea show during edit, but routed through the
  // host-public types `session.send` accepts.
  function buildRerunPayloadFromRecord(record) {
    const classified = classifyUserRecordBlocks(record);
    const prose = classified.proseText || '';
    const attachments = [];
    const content = transcriptContent(record);
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = unwrapTranscriptContentBlock(item);
        if (!block || block.type !== 'image') continue;
        const att = imageBlockToAttachment(block);
        if (att) attachments.push(att);
      }
    }
    const savedIdeRef = extractSavedIdeRef(record);
    return { prose, attachments, savedIdeRef };
  }

  function transcriptText(record) {
    const content = transcriptContent(record);
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map(unwrapTranscriptContentBlock)
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n');
  }

  function transcriptHasText(record) {
    const content = transcriptContent(record);
    if (typeof content === 'string') return content.trim().length > 0;
    return Array.isArray(content) && content.some(block =>
      (block = unwrapTranscriptContentBlock(block)) &&
      block && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
    );
  }

  function transcriptHasToolResult(record) {
    const content = transcriptContent(record);
    return Array.isArray(content) && content.some(block => {
      block = unwrapTranscriptContentBlock(block);
      return block && block.type === 'tool_result';
    });
  }

  function recordHasSignedThinking(record) {
    if (!record || record.type !== 'assistant') return false;
    const content = transcriptContent(record);
    return Array.isArray(content) && content.some(block => {
      block = unwrapTranscriptContentBlock(block);
      return block && (block.type === 'thinking' || block.type === 'redacted_thinking');
    });
  }

  // Mirror of host-badge.cjs `userEditHasDownstreamSignedThinking`, but
  // read from the authoritative `messages.value` (not DOM — long
  // conversations virtualize downstream rows out of the DOM, so a DOM
  // sweep would falsely report "no thinking" and offer a Save that the
  // API would then reject). Anthropic verifies prior signed thinking
  // against its original turn; editing an upstream user in place while
  // those blocks survive poisons the next resume, so local Save is not
  // an option for such a user message — only Save and Rerun.
  function userRecordHasDownstreamSignedThinking(record) {
    if (!record || record.type !== 'user') return false;
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages)) return false;
    const idx = transcriptRecordIndex(messages, record);
    if (idx < 0) return false;
    for (let i = idx + 1; i < messages.length; i++) {
      if (recordHasSignedThinking(messages[i])) return true;
    }
    return false;
  }

  // Detect a compact-summary user record. The Claude Code CLI persists
  // these to JSONL with `isCompactSummary:true` + `isVisibleInTranscriptOnly:
  // true` flags, but the host's `UT()` wrapper drops everything except
  // `isSynthetic` when building Iz instances — so by the time the record
  // is in `messages.value` we can't read those flags. Fingerprint
  // instead by the literal CLI summary header string ("This session is
  // being continued from a previous conversation that ran out of
  // context."), which is the hardcoded compact-time prefix in the CLI
  // and matched 100% of the compact-summary records across 73 local
  // sessions probed.
  //
  // Why this matters: these records are not editable in any meaningful
  // sense. Mutating them via the local edit/rerun path would leave the
  // model with a synthesized "user said" turn whose content the user
  // never actually typed, and which the CLI's own compact bookkeeping
  // can't reconcile.
  const COMPACT_SUMMARY_PREFIX_RE =
    /^This session is being continued from a previous conversation that ran out of context\./;

  function firstTextOfRecord(record) {
    const content = transcriptContent(record);
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const block = unwrapTranscriptContentBlock(item);
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
      }
    }
    return null;
  }

  function isCompactSummaryRecord(record) {
    if (!record || record.type !== 'user') return false;
    const firstText = firstTextOfRecord(record);
    if (typeof firstText !== 'string') return false;
    return COMPACT_SUMMARY_PREFIX_RE.test(firstText);
  }

  // Detect a slash-command / local-command user record. The CLI persists
  // a `/<cmd> <args>`-style invocation (and its local stdout/stderr) as a
  // user text block of the host's internal command protocol —
  //   <command-name>/<cmd></command-name>
  //   <command-message>cmd</command-message>
  //   <command-args>args</command-args>
  // — NOT as the plain text the user typed. These must never reach the
  // inline editor: classifyUserRecordBlocks would surface the raw
  // `<command-*>` XML as editable prose (the "internal-format leak" the
  // user reported), and rerun would push that XML through session.send
  // as ordinary prose — the host's headless slash parser then rejects it
  // (see 2026-06-07 memo: dialog-entered slash commands are unavailable).
  // incipit has no slash-command send path, so the only honest treatment
  // is to drop edit/rerun and keep copy, exactly like compact summaries.
  const COMMAND_RECORD_PREFIX_RE = /^\s*<\/?(?:local-)?command-[a-z]+\b/i;

  function isSlashCommandRecord(record) {
    if (!record || record.type !== 'user') return false;
    const firstText = firstTextOfRecord(record);
    if (typeof firstText !== 'string') return false;
    return COMMAND_RECORD_PREFIX_RE.test(firstText);
  }

  function isTranscriptRecord(value) {
    const type = String(value && value.type || '');
    const hasHostIdentity =
      typeof value?.uuid === 'string' ||
      (type === 'assistant' && typeof value?.betaMessageId === 'string');
    return !!(
      value &&
      typeof value === 'object' &&
      hasHostIdentity &&
      /^(user|assistant|system|progress|attachment)$/.test(type) &&
      ('content' in value || 'message' in value)
    );
  }

  function findTranscriptRecordInValue(value, depth, seen) {
    if (!value || typeof value !== 'object' || depth < 0) return null;
    if (isTranscriptRecord(value)) return value;
    if (value.nodeType || value.window === value) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const preferred = [
      'message', 'timelineMessage', 'entry', 'item', 'record', 'msg',
      'content', 'current', 'value',
    ];
    for (const key of preferred) {
      const hit = findTranscriptRecordInValue(value[key], depth - 1, seen);
      if (hit) return hit;
    }

    let scanned = 0;
    for (const key of Object.keys(value)) {
      if (preferred.includes(key)) continue;
      if (++scanned > 40) break;
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findTranscriptRecordInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  function fiberMissResult(sawAnchor, sawFiber, detail = null) {
    const result = {
      ok: false,
      value: null,
      reason: sawAnchor ? (sawFiber ? 'shapeMiss' : 'noFiber') : 'notMounted',
    };
    if (detail) result.detail = detail;
    return result;
  }

  const transcriptRecordCap = defineCapability({
    name: 'runtime.fiber.transcriptRecord',
    layer: 'fiber',
    presence: 'always',
    shapeValidate: isTranscriptRecord,
    probe(el) {
      if (!el) return { ok: false, value: null, reason: 'notMounted' };
      let f = reactFiberForElement(el);
      if (!f) return { ok: false, value: null, reason: 'noFiber' };
      for (let i = 0; i < 50 && f; i++) {
        const hit = findTranscriptRecordInValue(f.memoizedProps, 4, new WeakSet());
        if (hit) return { ok: true, value: hit, reason: 'ok' };
        f = f.return;
      }
      return { ok: false, value: null, reason: 'shapeMiss' };
    },
  });

  function transcriptRecordForElement(el) {
    const result = transcriptRecordCap.read(el);
    return result.ok ? result.value : null;
  }

  function locateConnection() {
    return locateClaudeConnection();
  }

  function getActiveSessionId() {
    try {
      const state = kernelGetHostState();
      if (state && typeof state.sessionId === 'string' && state.sessionId) return state.sessionId;
    } catch (_) {}
    // Editing/rerun still goes through the host-side JSONL guard, which
    // verifies both sessionId and message uuid before writing. If the React
    // connection shape drifts or a long-running webview loses that pointer,
    // the official persisted webview state is a safer recovery path than
    // falling back to newest-mtime guessing.
    return getActiveClaudeSessionId({ allowStaleState: true });
  }

  function getActiveSessionCwd() {
    try {
      const state = kernelGetHostState();
      if (state && typeof state.cwd === 'string' && state.cwd) return state.cwd;
    } catch (_) {}
    try {
      const session = locateActiveSessionState();
      const cwd = session && session.cwd;
      if (cwd && typeof cwd === 'object' && typeof cwd.value === 'string') return cwd.value;
      if (typeof cwd === 'string') return cwd;
    } catch (_) {}
    return '';
  }

  // ============================================================
  // Sessions manager (`Un` in the bundle) — needed so we can
  // gracefully re-hydrate the current session after a JSONL
  // mutation, without `window.location.reload()` (which blanks the
  // panel because VS Code webviews can only `acquireVsCodeApi()`
  // once per lifecycle).
  //
  // Decompiled flow we exploit:
  //
  //   class Un {
  //     sessions = L0([]);             // signal: SessionState[]
  //     activeSession = L0(undefined); // signal: current SessionState
  //
  //     async activateSessionFromServer(id, prompt) {
  //       // already-in-list path: just switches activeSession
  //       const found = this.sessions.value.find(s => s.sessionId.value === id);
  //       if (found) { this.activeSession.value = found; return true; }
  //       // not-in-list path: nX.fromServer(...) → new SessionState
  //       const meta = (await getConnection().listSessions()).sessions.find(s => s.id === id);
  //       const G = nX.fromServer(meta, ...);
  //       this.sessions.value = [G, ...this.sessions.value];
  //       this.activeSession.value = G;
  //       return true;
  //     }
  //   }
  //
  // We force the not-in-list path by removing the current session
  // from `sessions.value` first. After activate, we manually call
  // `loadFromServer()` on the new SessionState — that walks the
  // jsonl through `s$()` (filesystem read, no in-memory cache) and
  // its tail invokes `launchClaude()` to spawn a fresh Claude CLI
  // process in resume mode. The new CLI reads the freshly-edited
  // JSONL, so subsequent user input addresses the correct context.
  //
  // The old Claude CLI for the previous channelId is interrupted
  // first; host-side process cleanup is the host's responsibility
  // once the channel is unreferenced (matches what the official
  // fork flow leaves behind too).
  function isSessionsManagerLike(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.activateSessionFromServer !== 'function') return false;
    const ses = obj.sessions;
    if (!ses || typeof ses !== 'object' || !('value' in ses)) return false;
    const act = obj.activeSession;
    if (!act || typeof act !== 'object' || !('value' in act)) return false;
    return true;
  }

  let cachedSessionsManager = null;

  function findSessionsManagerInValue(value, depth, seen) {
    if (!value || typeof value !== 'object' || depth < 0) return null;
    if (isSessionsManagerLike(value)) return value;
    if (value.nodeType || value.window === value) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const preferred = ['sessions', 'context', 'value', 'current'];
    for (const key of preferred) {
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findSessionsManagerInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    let scanned = 0;
    for (const key of Object.keys(value)) {
      if (preferred.includes(key)) continue;
      if (++scanned > 25) break;
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findSessionsManagerInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  const sessionsManagerCap = defineCapability({
    name: 'runtime.fiber.sessionsManager',
    layer: 'fiber',
    presence: 'always',
    shapeValidate: isSessionsManagerLike,
    probe() {
      if (cachedSessionsManager && isSessionsManagerLike(cachedSessionsManager)) {
        return { ok: true, value: cachedSessionsManager, reason: 'ok', detail: { source: 'cache' } };
      }
      const anchors = [
        document.querySelector('[class*="root_"]'),
        document.querySelector('[class*="messagesContainer_"]'),
        document.querySelector('[class*="userMessage_"]'),
        document.querySelector('[class*="inputContainer_"]'),
        document.body && document.body.firstElementChild,
        document.body,
      ];
      let sawAnchor = false;
      let sawFiber = false;
      for (const anchor of anchors) {
        if (!anchor) continue;
        sawAnchor = true;
        let f = reactFiberForElement(anchor);
        if (f) sawFiber = true;
        for (let i = 0; i < 120 && f; i++) {
          let mgr = findSessionsManagerInValue(f.memoizedProps, 6, new WeakSet());
          if (!mgr) mgr = findSessionsManagerInValue(f.stateNode, 6, new WeakSet());
          if (!mgr) mgr = findSessionsManagerInValue(f.memoizedState, 6, new WeakSet());
          if (mgr) {
            cachedSessionsManager = mgr;
            return { ok: true, value: mgr, reason: 'ok', detail: { source: 'fiber' } };
          }
          f = f.return;
        }
      }
      return fiberMissResult(sawAnchor, sawFiber);
    },
  });

  function locateSessionsManager() {
    const result = sessionsManagerCap.read();
    return result.ok ? result.value : null;
  }

  // ============================================================
  // Active SessionState (`nX` instance) — needed for in-place
  // updates of messages.value (instant UI reflection of edits/
  // deletes, no `Loading...` placeholder, no flicker) and for
  // tearing down the current Claude CLI process so the next send
  // re-spawns it from the freshly-edited JSONL.
  //
  // Fingerprint: a SessionState owns the methods `loadFromServer`
  // and `launchClaude`, plus signal-like `messages` / `sessionId`
  // and the writable field `claudeChannelId`. The combination is
  // unique to `nX` in this bundle.
  // ============================================================
  function isSessionStateLike(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.loadFromServer !== 'function') return false;
    if (typeof obj.launchClaude !== 'function') return false;
    const m = obj.messages;
    if (!m || typeof m !== 'object' || !('value' in m)) return false;
    const s = obj.sessionId;
    if (!s || typeof s !== 'object' || !('value' in s)) return false;
    if (!('claudeChannelId' in obj)) return false;
    return true;
  }

  function findSessionStateInValue(value, depth, seen) {
    if (!value || typeof value !== 'object' || depth < 0) return null;
    if (isSessionStateLike(value)) return value;
    if (value.nodeType || value.window === value) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const preferred = ['session', 'activeSession', 'value', 'current', 'context'];
    for (const key of preferred) {
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findSessionStateInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    let scanned = 0;
    for (const key of Object.keys(value)) {
      if (preferred.includes(key)) continue;
      if (++scanned > 25) break;
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findSessionStateInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  const activeSessionObjectCap = defineCapability({
    name: 'runtime.fiber.activeSessionObject',
    layer: 'fiber',
    presence: 'always',
    shapeValidate: isSessionStateLike,
    probe() {
      // Try sessions manager's activeSession.value first — this is the
      // canonical pointer the host itself maintains.
      const mgr = locateSessionsManager();
      let managerDetail = null;
      if (mgr) {
        try {
          const cand = mgr.activeSession && mgr.activeSession.value;
          if (cand && isSessionStateLike(cand)) {
            return { ok: true, value: cand, reason: 'ok', detail: { source: 'sessionsManager' } };
          }
        } catch (error) {
          managerDetail = { managerError: error && error.message ? error.message : String(error) };
        }
      }
      const anchors = [
        document.querySelector('[class*="messagesContainer_"]'),
        document.querySelector('[class*="userMessage_"]'),
        document.querySelector('[class*="root_"]'),
        document.body && document.body.firstElementChild,
        document.body,
      ];
      let sawAnchor = false;
      let sawFiber = false;
      for (const anchor of anchors) {
        if (!anchor) continue;
        sawAnchor = true;
        let f = reactFiberForElement(anchor);
        if (f) sawFiber = true;
        for (let i = 0; i < 120 && f; i++) {
          let s = findSessionStateInValue(f.memoizedProps, 6, new WeakSet());
          if (!s) s = findSessionStateInValue(f.stateNode, 6, new WeakSet());
          if (!s) s = findSessionStateInValue(f.memoizedState, 6, new WeakSet());
          if (s) return { ok: true, value: s, reason: 'ok', detail: { source: 'fiber' } };
          f = f.return;
        }
      }
      return fiberMissResult(sawAnchor, sawFiber, managerDetail);
    },
  });

  function locateActiveSessionState() {
    const result = activeSessionObjectCap.read();
    return result.ok ? result.value : null;
  }

  // ============================================================
  // Active AppContext — owner of `forkConversation(sessionId,
  // promptText, prevUuid)`. Fork lives on the AppState class (one
  // level above SessionState): it needs to allocate a new session,
  // optionally open a new tab (config.openNewInTab), then call
  // viewSession/startNewConversationTab. We must NOT call
  // session.forkConversation — there is no such method; the host
  // explicitly wires fork through context, not session (verified
  // against extension.js 2.1.120).
  //
  // Fingerprint: an AppContext owns `forkConversation`, plus at
  // least one of (viewSession / startNewConversationTab), plus a
  // `comms` field with a `connection` signal. The triple is unique
  // to this class in the bundle.
  // ============================================================
  function isAppContextLike(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.forkConversation !== 'function') return false;
    if (typeof obj.viewSession !== 'function' &&
        typeof obj.startNewConversationTab !== 'function') return false;
    const c = obj.comms;
    if (!c || typeof c !== 'object') return false;
    const conn = c.connection;
    if (!conn || typeof conn !== 'object' || !('value' in conn)) return false;
    return true;
  }

  function findAppContextInValue(value, depth, seen) {
    if (!value || typeof value !== 'object' || depth < 0) return null;
    if (isAppContextLike(value)) return value;
    if (value.nodeType || value.window === value) return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const preferred = ['context', 'app', 'appContext', 'value', 'current'];
    for (const key of preferred) {
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findAppContextInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    let scanned = 0;
    for (const key of Object.keys(value)) {
      if (preferred.includes(key)) continue;
      if (++scanned > 25) break;
      const v = value[key];
      if (!v || typeof v !== 'object') continue;
      const hit = findAppContextInValue(v, depth - 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  let cachedAppContext = null;
  const appContextCap = defineCapability({
    name: 'runtime.fiber.appContext',
    layer: 'fiber',
    presence: 'always',
    shapeValidate: isAppContextLike,
    probe() {
      if (cachedAppContext && isAppContextLike(cachedAppContext)) {
        return { ok: true, value: cachedAppContext, reason: 'ok', detail: { source: 'cache' } };
      }
      const anchors = [
        document.querySelector('[class*="root_"]'),
        document.querySelector('[class*="messagesContainer_"]'),
        document.querySelector('[class*="userMessage_"]'),
        document.querySelector('[class*="inputContainer_"]'),
        document.body && document.body.firstElementChild,
        document.body,
      ];
      let sawAnchor = false;
      let sawFiber = false;
      for (const anchor of anchors) {
        if (!anchor) continue;
        sawAnchor = true;
        let f = reactFiberForElement(anchor);
        if (f) sawFiber = true;
        for (let i = 0; i < 120 && f; i++) {
          let ctx = findAppContextInValue(f.memoizedProps, 6, new WeakSet());
          if (!ctx) ctx = findAppContextInValue(f.stateNode, 6, new WeakSet());
          if (!ctx) ctx = findAppContextInValue(f.memoizedState, 6, new WeakSet());
          if (ctx) {
            cachedAppContext = ctx;
            return { ok: true, value: ctx, reason: 'ok', detail: { source: 'fiber' } };
          }
          f = f.return;
        }
      }
      return fiberMissResult(sawAnchor, sawFiber);
    },
  });

  function locateActiveAppContext() {
    const result = appContextCap.read();
    return result.ok ? result.value : null;
  }

  // ============================================================
  // Custom model picker.
  //
  // Claude Code's headless slash parser rejects the model-switch command
  // in the webview environment, but the official UI model switcher is
  // still available through SessionState.setModel(modelObject). Keep this
  // as a UI shell over that host path: no slash command, no request/auth
  // rewrites, and no private recent-model storage in the command menu.
  // ============================================================
  const CUSTOM_MODEL_ACTION_ID = 'incipit-custom-model-id';
  const CUSTOM_MODEL_ACTION_LABEL = legacyText('use_custom_model_id_action');
  const CUSTOM_MODEL_REGISTER_TIMEOUT_MS = 10000;
  const customModelRegisteredRegistries = new WeakSet();
  let customModelRegisterStarted = false;
  let customModelRegisterTimer = 0;
  let commandMenuSelectionCleanupObserver = null;
  let commandMenuSelectionCleanupScheduled = false;
  let customModelActionDecorationObserver = null;
  let customModelActionDecorationScheduled = false;
  let customModelDialog = null;

  function commandRegistryFromAppContext(ctx) {
    const registry = ctx && ctx.commandRegistry;
    if (!registry || typeof registry !== 'object') return null;
    return typeof registry.registerAction === 'function' ? registry : null;
  }

  function locateCommandRegistry() {
    return commandRegistryFromAppContext(locateActiveAppContext());
  }

  function modelDisplayNameFromId(raw) {
    const value = String(raw || '').trim();
    return value || legacyText('custom_model');
  }

  function makeCustomModelOption(raw) {
    const value = String(raw || '').trim();
    return {
      value,
      displayName: modelDisplayNameFromId(value),
      description: legacyText('custom_model_id_description'),
    };
  }

  function closeCustomModelDialog() {
    if (!customModelDialog) return;
    const dialog = customModelDialog;
    customModelDialog = null;
    document.removeEventListener('keydown', dialog.onKeyDown, true);
    if (dialog.backdrop && dialog.backdrop.parentElement) dialog.backdrop.remove();
  }

  function setCustomModelDialogError(dialog, message) {
    if (!dialog || !dialog.errorEl) return;
    const text = message ? String(message) : '';
    dialog.errorEl.textContent = text;
    if (text) dialog.errorEl.setAttribute('data-visible', '1');
    else dialog.errorEl.removeAttribute('data-visible');
  }

  function setCustomModelDialogBusy(dialog, busy) {
    if (!dialog) return;
    const value = busy ? '1' : '0';
    if (dialog.backdrop) dialog.backdrop.dataset.incipitBusy = value;
    if (dialog.input) dialog.input.disabled = !!busy;
    if (dialog.submit) dialog.submit.disabled = !!busy;
  }

  async function submitCustomModelDialog(dialog) {
    if (!dialog || !dialog.input) return;
    const raw = String(dialog.input.value || '').trim();
    if (!raw) {
      setCustomModelDialogError(dialog, legacyText('custom_model_enter_id'));
      try { dialog.input.focus(); } catch (_) {}
      return;
    }
    const session = locateActiveSessionState();
    if (!session || typeof session.setModel !== 'function') {
      setCustomModelDialogError(dialog, legacyText('custom_model_session_not_ready'));
      return;
    }
    setCustomModelDialogBusy(dialog, true);
    setCustomModelDialogError(dialog, '');
    try {
      const result = await session.setModel(makeCustomModelOption(raw));
      if (result === false) throw new Error('The host rejected this model ID.');
      closeCustomModelDialog();
    } catch (error) {
      const msg = error && error.message ? error.message : String(error || 'Unknown error');
      setCustomModelDialogError(dialog, legacyText('custom_model_set_failed', { msg }));
      setCustomModelDialogBusy(dialog, false);
      try { dialog.input.focus(); } catch (_) {}
    }
  }

  function openCustomModelDialog() {
    closeCustomModelDialog();
    if (!document.body) return;

    const backdrop = document.createElement('div');
    backdrop.setAttribute('data-incipit-custom-model-modal', '');
    backdrop.tabIndex = -1;

    const panel = document.createElement('div');
    panel.setAttribute('data-incipit-custom-model-dialog', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'incipit-custom-model-title');
    panel.addEventListener('click', evt => evt.stopPropagation());

    const header = document.createElement('div');
    header.setAttribute('data-incipit-custom-model-header', '');

    const title = document.createElement('div');
    title.id = 'incipit-custom-model-title';
    title.setAttribute('data-incipit-custom-model-title', '');
    title.textContent = legacyText('custom_model');

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-incipit-custom-model-close', '');
    close.setAttribute('aria-label', legacyText('close'));
    close.textContent = '\u00d7';
    close.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      closeCustomModelDialog();
    });

    header.appendChild(title);
    header.appendChild(close);

    const body = document.createElement('form');
    body.setAttribute('data-incipit-custom-model-body', '');
    body.addEventListener('submit', evt => {
      evt.preventDefault();
      submitCustomModelDialog(customModelDialog);
    });

    const label = document.createElement('label');
    label.setAttribute('data-incipit-custom-model-label', '');
    label.setAttribute('for', 'incipit-custom-model-input');
    label.textContent = legacyText('model_id_label');

    const input = document.createElement('input');
    input.id = 'incipit-custom-model-input';
    input.setAttribute('data-incipit-custom-model-input', '');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'claude-opus-4-6[1m]';

    const error = document.createElement('div');
    error.setAttribute('data-incipit-custom-model-error', '');
    error.setAttribute('role', 'alert');

    const actions = document.createElement('div');
    actions.setAttribute('data-incipit-custom-model-actions', '');

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('data-incipit-custom-model-cancel', '');
    cancel.textContent = legacyText('cancel');
    cancel.addEventListener('click', evt => {
      evt.preventDefault();
      closeCustomModelDialog();
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.setAttribute('data-incipit-custom-model-submit', '');
    submit.textContent = legacyText('use_model');

    actions.appendChild(cancel);
    actions.appendChild(submit);
    body.appendChild(label);
    body.appendChild(input);
    body.appendChild(error);
    body.appendChild(actions);
    panel.appendChild(header);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', evt => {
      if (evt.target !== backdrop) return;
      evt.preventDefault();
      closeCustomModelDialog();
    });

    const onKeyDown = evt => {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      closeCustomModelDialog();
    };
    document.addEventListener('keydown', onKeyDown, true);
    customModelDialog = { backdrop, panel, input, submit, errorEl: error, onKeyDown };
    document.body.appendChild(backdrop);
    setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
  }

  function customModelMenuText(node) {
    return String(node && node.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function commandMenuListsFrom(root) {
    const start = root && root.nodeType === 1 ? root : root && root.parentElement;
    if (!start) return [];
    const lists = [];
    if (start.matches?.(SEL.commandList)) lists.push(start);
    const closest = start.closest?.(SEL.commandList);
    if (closest && !lists.includes(closest)) lists.push(closest);
    start.querySelectorAll?.(SEL.commandList).forEach(list => {
      if (!lists.includes(list)) lists.push(list);
    });
    return lists;
  }

  function clearCommandMenuItemSelection(item) {
    if (!item || item.nodeType !== 1) return;
    if (item.getAttribute('aria-selected') === 'true') item.removeAttribute('aria-selected');
    item.removeAttribute(ATTR.commandItemActive);
    if (!item.classList) return;
    for (const cls of Array.from(item.classList)) {
      if (cls === 'active' || cls.indexOf('activeCommandItem') !== -1) {
        item.classList.remove(cls);
      }
    }
  }

  // Slash-command menu rows are transient actions/submenus, not durable
  // settings. If the host remounts them with a clicked row still marked
  // active/selected, clear only that command-list state; permission/dropdown
  // menus keep their real selection state outside SEL.commandList.
  function clearCommandMenuTransientSelection(root = document.body) {
    for (const list of commandMenuListsFrom(root)) {
      list.removeAttribute('aria-activedescendant');
      list.querySelectorAll(SEL.commandItem + ', [class*="commandItem"], [aria-selected="true"], [' + ATTR.commandItemActive + ']').forEach(node => {
        const item = node.closest?.(SEL.commandItem) || node.closest?.('[class*="commandItem"]') || node;
        if (item && list.contains(item)) clearCommandMenuItemSelection(item);
      });
    }
  }

  function scheduleCommandMenuTransientSelectionCleanup(root = document.body) {
    if (commandMenuSelectionCleanupScheduled) return;
    commandMenuSelectionCleanupScheduled = true;
    requestAnimationFrame(() => {
      commandMenuSelectionCleanupScheduled = false;
      clearCommandMenuTransientSelection(document.body || root);
    });
  }

  function setupCommandMenuTransientSelectionCleanup() {
    if (!document.body || commandMenuSelectionCleanupObserver) return;
    scheduleCommandMenuTransientSelectionCleanup(document.body);
    commandMenuSelectionCleanupObserver = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type !== 'childList' || !m.addedNodes.length) continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(SEL.commandList) || node.matches?.(SEL.commandItem) ||
              node.querySelector?.(SEL.commandList) || node.querySelector?.(SEL.commandItem)) {
            scheduleCommandMenuTransientSelectionCleanup(node);
            return;
          }
        }
      }
    });
    commandMenuSelectionCleanupObserver.observe(document.body, { childList: true, subtree: true });
  }

  function customModelActionElementFrom(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || !el.querySelectorAll) return null;
    if (customModelMenuText(el) !== CUSTOM_MODEL_ACTION_LABEL) return null;
    for (const child of el.children || []) {
      if (customModelMenuText(child) === CUSTOM_MODEL_ACTION_LABEL) return null;
    }
    const interactive = el.closest('button, [role="menuitem"], [tabindex]');
    const row = interactive || el.closest('[class*="item"], [class*="action"], [class*="row"]') || el;
    if (!row || row === document.body || row === document.documentElement) return null;
    return row;
  }

  function markCustomModelActionDecorations(root = document.body) {
    if (!root || !document.body) return;
    const start = root.nodeType === 1 ? root : root.parentElement;
    if (!start) return;
    if (customModelMenuText(start).indexOf(CUSTOM_MODEL_ACTION_LABEL) === -1) return;
    const candidates = [start];
    if (start.querySelectorAll) {
      start.querySelectorAll('button, [role="menuitem"], [tabindex], [class*="item"], [class*="action"], [class*="row"], span, div')
        .forEach(el => candidates.push(el));
    }
    for (const candidate of candidates) {
      const action = customModelActionElementFrom(candidate);
      if (action) action.setAttribute('data-incipit-custom-model-action', '');
    }
  }

  function scheduleCustomModelActionDecoration(root = document.body) {
    if (customModelActionDecorationScheduled) return;
    customModelActionDecorationScheduled = true;
    requestAnimationFrame(() => {
      customModelActionDecorationScheduled = false;
      markCustomModelActionDecorations(root);
    });
  }

  function setupCustomModelActionDecoration() {
    if (!document.body || customModelActionDecorationObserver) return;
    scheduleCustomModelActionDecoration(document.body);
    customModelActionDecorationObserver = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type !== 'childList' || !m.addedNodes.length) continue;
        for (const node of m.addedNodes) {
          if (String(node && node.textContent || '').indexOf(CUSTOM_MODEL_ACTION_LABEL) !== -1) {
            scheduleCustomModelActionDecoration(node);
            return;
          }
        }
      }
    });
    customModelActionDecorationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function tryRegisterCustomModelAction() {
    const registry = locateCommandRegistry();
    if (!registry) return false;
    if (customModelRegisteredRegistries.has(registry)) return true;
    try {
      registry.registerAction({
        id: CUSTOM_MODEL_ACTION_ID,
        label: CUSTOM_MODEL_ACTION_LABEL,
        description: legacyText('set_model_by_full_id'),
      }, 'Model', () => openCustomModelDialog());
      customModelRegisteredRegistries.add(registry);
      setupCustomModelActionDecoration();
      reportHealth('legacy.custom_model', 'ok');
      return true;
    } catch (error) {
      warn('Could not register custom model action:', error);
      reportHealth('legacy.custom_model', 'degraded', { reason: 'register-failed' });
      return true;
    }
  }

  function setupCustomModelPicker() {
    if (customModelRegisterStarted) return;
    customModelRegisterStarted = true;
    const startedAt = Date.now();
    const tick = () => {
      if (tryRegisterCustomModelAction()) return;
      if (Date.now() - startedAt >= CUSTOM_MODEL_REGISTER_TIMEOUT_MS) {
        reportHealth('legacy.custom_model', 'degraded', { reason: 'no-command-registry' });
        return;
      }
      customModelRegisterTimer = setTimeout(tick, 250);
    };
    tick();
  }

  // Look up the *current* record by uuid from active SessionState's
  // messages.value. Edits replace the Ez instance in the array (uuid
  // stable, identity changes), so any callback that captured the
  // original record at decoration time will hold a stale reference
  // after the user edits and clicks rerun/re-edit/copy. Always resolve
  // through this helper at click time to read current text.
  function liveTranscriptRecord(uuid, fallback) {
    const wantedUuid =
      (typeof uuid === 'string' && uuid) ||
      (typeof fallback?.uuid === 'string' && fallback.uuid) ||
      '';
    const wantedBeta =
      (typeof fallback?.betaMessageId === 'string' && fallback.betaMessageId) ||
      '';
    if (!wantedUuid && !wantedBeta) return fallback;
    try {
      const s = locateActiveSessionState();
      if (s && s.messages && Array.isArray(s.messages.value)) {
        let hit = null;
        if (fallback) {
          const identityIdx = s.messages.value.indexOf(fallback);
          if (identityIdx >= 0) hit = s.messages.value[identityIdx];
        }
        if (!hit && wantedUuid) {
          for (let i = s.messages.value.length - 1; i >= 0; i--) {
            const m = s.messages.value[i];
            if (m && m.uuid === wantedUuid) {
              hit = m;
              break;
            }
          }
        }
        if (!hit && wantedBeta) {
          for (let i = s.messages.value.length - 1; i >= 0; i--) {
            const m = s.messages.value[i];
            if (m && m.betaMessageId === wantedBeta) {
              hit = m;
              break;
            }
          }
        }
        if (hit) return hit;
      }
    } catch (_) {}
    return fallback;
  }

  // Build an edited copy of a host message object.
  //
  // SHAPE NOTE (reverse-engineered from `webview/index.js` 2.1.118):
  // `messages.value` does not hold raw JSONL records. Each entry is an
  // `Ez` instance with the flat shape
  //   { type, uuid, betaMessageId, content, timestamp,
  //     parentToolUseId, isSynthetic, compactMetadata }
  // and `content` is a `SY[]` array. Each `SY` wraps one JSONL block:
  //   { content: { type:'text', text }, partial, hash, lastModifiedTime,
  //     toolResultSignal, progressSignal, ... }
  // React renders blocks via `J.content.map(B => createElement(yW,
  // {key: B.key, ...}))`, where `B.key === B.hash + B.lastModifiedTime`.
  //
  // To make the webview re-render after an edit we must:
  //   1. Build a brand-new `SY` (new hash → new key → React unmounts the
  //      old block and mounts a new one with the new text).
  //   2. Build a brand-new `Ez` (new instance → React.memo on the row
  //      sees a different prop reference and re-renders this message).
  //   3. Hand back the new `Ez` so the caller can place it into a fresh
  //      `messages.value` array (signal subscribers fire, useMemo deps
  //      invalidate).
  // We pull the constructors off the existing instances, so we don't
  // need to anchor to the minified class names. Failure path: return
  // the original message — caller's array slice is still a new array
  // reference, so the rest of the reflect pipeline (interrupt + clear
  // channelId) still runs.
  function makeEditedMessage(message, newText) {
    if (!message || typeof message !== 'object') return message;
    if (!Array.isArray(message.content) || message.content.length === 0) return message;

    let textIdx = -1;
    for (let i = 0; i < message.content.length; i++) {
      const sy = message.content[i];
      const c = sy && sy.content;
      if (c && c.type === 'text' && typeof c.text === 'string') {
        textIdx = i;
        break;
      }
    }
    if (textIdx < 0) return message;

    const oldSy = message.content[textIdx];
    const SyCtor = oldSy && oldSy.constructor;
    if (typeof SyCtor !== 'function') return message;
    let newSy;
    try {
      newSy = new SyCtor({ ...oldSy.content, text: newText }, !!oldSy.partial);
    } catch (_) { return message; }

    const newContent = message.content.slice();
    newContent[textIdx] = newSy;

    const EzCtor = message.constructor;
    if (typeof EzCtor !== 'function') return message;
    try {
      return new EzCtor(message.type, newContent, {
        uuid: message.uuid,
        betaMessageId: message.betaMessageId,
        timestamp: message.timestamp,
        parentToolUseId: message.parentToolUseId,
        isSynthetic: message.isSynthetic,
        compactMetadata: message.compactMetadata,
      });
    } catch (_) { return message; }
  }

  // Block-aware companion to makeEditedMessage. The save path for rich
  // user edits sends a `blocks` spec (kept-by-index + new text + new
  // images); reflect needs to rebuild the Ez accordingly.
  //
  // Why reuse the original SY for `kind:'keep'` (vs constructing a
  // fresh one with the same JSONL block): SY carries `hash` and
  // `lastModifiedTime`, and React keys block components by
  // `B.hash + B.lastModifiedTime`. Reusing the same SY → same key →
  // React doesn't unmount that block. For images this matters: a fresh
  // SY with the same data URL would still cause a React unmount/mount
  // pair (the block's own React component re-creation), which can
  // briefly blank the image while the browser re-decodes the base64.
  // Keep-by-reference avoids the flicker entirely.
  function makeEditedMessageBlocks(message, blocksSpec) {
    if (!message || typeof message !== 'object') return message;
    if (!Array.isArray(message.content)) return message;
    if (!Array.isArray(blocksSpec) || blocksSpec.length === 0) return message;

    const oldContent = message.content;
    let SyCtor = null;
    for (const sy of oldContent) {
      if (sy && typeof sy.constructor === 'function') {
        SyCtor = sy.constructor;
        break;
      }
    }
    if (!SyCtor) return message;

    const newContent = [];
    for (const spec of blocksSpec) {
      if (spec.kind === 'keep' &&
          Number.isInteger(spec.index) &&
          spec.index >= 0 &&
          spec.index < oldContent.length) {
        newContent.push(oldContent[spec.index]);
      } else if (spec.kind === 'text' && typeof spec.text === 'string') {
        try { newContent.push(new SyCtor({ type: 'text', text: spec.text }, false)); }
        catch (_) { /* skip on shape drift */ }
      } else if (spec.kind === 'image' &&
                 spec.source && typeof spec.source === 'object' &&
                 spec.source.type === 'base64' &&
                 typeof spec.source.data === 'string' &&
                 typeof spec.source.media_type === 'string') {
        try { newContent.push(new SyCtor({ type: 'image', source: spec.source }, false)); }
        catch (_) { /* skip on shape drift */ }
      }
    }
    if (newContent.length === 0) return message;

    const EzCtor = message.constructor;
    if (typeof EzCtor !== 'function') return message;
    try {
      return new EzCtor(message.type, newContent, {
        uuid: message.uuid,
        betaMessageId: message.betaMessageId,
        timestamp: message.timestamp,
        parentToolUseId: message.parentToolUseId,
        isSynthetic: message.isSynthetic,
        compactMetadata: message.compactMetadata,
      });
    } catch (_) { return message; }
  }

  // Identity payload for transcript mutations. `sessionId` comes from the
  // connection signal (authoritative). `cwd` is best-effort off the record
  // (each JSONL entry carries it natively); host doesn't need it because
  // it can scan project dirs by sessionId, but sending when available lets
  // host short-circuit the scan.
  function transcriptRecordIdentity(record) {
    const sessionId = getActiveSessionId();
    if (!sessionId) return null;
    const cwd =
      (record && (record.cwd || record.message?.cwd || record.entry?.cwd || record.content?.cwd)) ||
      null;
    return { sessionId, cwd };
  }

  // Static lookup of which kinds get a streaming-disabled variant SVG.
  // - copy / more: live during streaming (copy never depends on
  //   transcript state; the more dropdown only ever exposes copy
  //   variants right now).
  // - rerun: disabled visuals are colour + opacity only (no slash);
  //   we still want the busy-state machinery to flip its data attr so
  //   the click handler swallows, but no innerHTML swap.
  // - edit: traditional slash overlay so the disabled state is
  //   unmistakable next to a live rerun/copy in the same row.
  const DISABLED_ICON_BY_KIND = {
    edit: EDIT_ICON_DISABLED_SVG,
  };
  // Kinds that should still flip data-incipit-disabled even though they
  // have no swap-icon — CSS owns the visual delta. Rerun + fork share
  // the same colour-only treatment (single primitive verbs, not
  // slash-able like edit/delete).
  const COLOR_ONLY_DISABLED_KINDS = new Set(['rerun', 'fork']);

  function makeTranscriptActionButton(kind, title, iconSvg, handler) {
    const btn = document.createElement('button');
    btn.className = `claude-user-copy-btn incipit-transcript-action-btn incipit-transcript-action-${kind}`;
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = iconSvg;
    btn.dataset.incipitActionKind = kind;
    // Stash live + disabled assets on the node so reconcile flips can
    // run without needing to touch the SVG dictionaries again.
    btn._incipitLiveIcon = iconSvg;
    btn._incipitDisabledIcon = DISABLED_ICON_BY_KIND[kind] || null;
    btn._incipitLiveTitle = title;
    btn._incipitColorOnlyDisabled = COLOR_ONLY_DISABLED_KINDS.has(kind);
    btn._incipitBlocksWhileBusy = !!(btn._incipitDisabledIcon || btn._incipitColorOnlyDisabled);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // Streaming gate: any button currently flagged disabled swallows
      // the click silently. No toast (would compete with the input box
      // that's already locked while streaming).
      if (btn.dataset.incipitDisabled === '1') return;
      if (btn._incipitBlocksWhileBusy) {
        let busy = false;
        try { busy = conversationIsBusy(); } catch (_) { busy = false; }
        if (busy) {
          applyButtonBusyState(btn, true);
          return;
        }
      }
      try {
        const result = handler(btn, e);
        if (result && typeof result.then === 'function') {
          result.catch(error => {
            warn('transcript action failed:', kind, error);
            showTranscriptToast(legacyText('action_failed'), 'error');
          });
        }
      } catch (error) {
        warn('transcript action failed:', kind, error);
        showTranscriptToast(legacyText('action_failed'), 'error');
      }
    });
    return btn;
  }

  // Idempotent state-flip on a single button. Bails out when target
  // state matches current — this is the hot-path during streaming so
  // the no-op branch must stay free of DOM writes.
  function applyButtonBusyState(btn, busy) {
    if (!btn) return;
    // Buttons that don't participate at all in the streaming gate (copy
    // / more — both safe during streaming).
    if (!btn._incipitDisabledIcon && !btn._incipitColorOnlyDisabled) return;
    const wantDisabled = !!busy;
    const isDisabled = btn.dataset.incipitDisabled === '1';
    if (wantDisabled === isDisabled) return;
    if (wantDisabled) {
      btn.dataset.incipitDisabled = '1';
      // Slash-overlay kinds (edit) swap the SVG; colour-only kinds
      // (rerun) leave the SVG alone and let CSS handle the visual via
      // the data attr selector.
      if (btn._incipitDisabledIcon) btn.innerHTML = btn._incipitDisabledIcon;
      // Drop the title attr so hover yields no tooltip (per UX brief).
      // Keep aria-disabled so a11y still surfaces the state.
      btn.removeAttribute('title');
      btn.setAttribute('aria-disabled', 'true');
    } else {
      delete btn.dataset.incipitDisabled;
      if (btn._incipitDisabledIcon) btn.innerHTML = btn._incipitLiveIcon;
      if (btn._incipitLiveTitle) btn.setAttribute('title', btn._incipitLiveTitle);
      btn.removeAttribute('aria-disabled');
    }
  }

  // Sweep all currently-mounted action buttons, snap them to the busy
  // state. Cheap because applyButtonBusyState early-returns on no-op.
  // Inline-edit save buttons go through their own busy-flip helper —
  // the same observer/sweep pulse drives both, so the inline editor
  // stays consistent with the icon row even mid-edit.
  function sweepStreamingDisableState() {
    const busy = conversationIsBusy();
    if (busy) {
      try { removeCurrentBusyAssistantTerminalDecorations(); } catch (_) {}
    }
    const icons = document.querySelectorAll('.incipit-transcript-action-btn');
    for (const btn of icons) applyButtonBusyState(btn, busy);
    const saves = document.querySelectorAll('.incipit-inline-edit-save');
    for (const btn of saves) applyInlineSaveBusyState(btn, busy);
  }

  const TRANSCRIPT_ACTION_QUIET_MS = 360;
  const TRANSCRIPT_ACTION_BUSY_POLL_MS = 240;
  let lastTranscriptMutationAt = 0;
  let transcriptActionSettleTimer = null;
  let transcriptActionBurstToken = 0;

  // ---- Turn-handoff serialization (interrupt → edit → rerun safety) ----
  //
  // Root cause of the "Mismatched content block type content_block_delta
  // thinking" + send/stop flicker + editable action row appearing
  // mid-stream: incipit used to resend immediately after truncate while
  // the just-interrupted CLI was still flushing, so two live streams fed
  // the host's single root stream-assembler. The host `busy` boolean
  // flips false on interrupt *before* the old process actually drains,
  // so it must not be trusted as the only gate.
  //
  // These knobs drive a bounded "quiesce, then hand off" wait: the old
  // turn must be genuinely settled (busy stable-false + the truncated
  // JSONL not advanced by any writer + interrupt cooldown elapsed + no
  // dangerous tail) before the fresh send is allowed.
  const TURN_HANDOFF_TIMEOUT_MS = 8000;
  const TURN_HANDOFF_QUIET_MS = 700;
  const TURN_HANDOFF_POLL_MS = 120;
  const CHANNEL_INTERRUPT_COOLDOWN_MS = 600;
  // Post-truncate confirmation is short: the heavy waiting already
  // happened pre-truncate, so this only guards the rare race of a writer
  // appending right around the cut instant.
  const CUT_CONFIRM_TIMEOUT_MS = 1800;
  // Fix 4: the action-row settle scan must see busy continuously false
  // for this long before it mints rows, so a transient send→stop→send
  // oscillation no longer churns the editable footer / send icon.
  const BUSY_UI_STABLE_MS = 420;
  const SEND_BUTTON_DOM_CACHE_MS = 32;
  let lastChannelInterruptAt = 0;
  let historyHandoffInFlight = false;
  let busyFalseStableSince = 0;
  let sendButtonDomCachedAt = 0;
  let sendButtonDomCachedValue = null;

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  // Every place that tears down the live Claude CLI channel funnels its
  // `conn.interruptClaude(...)` call through here so the rerun preflight
  // can enforce a cooldown: an interrupt issued microseconds ago has not
  // drained the old streaming process yet.
  function noteChannelInterrupt() {
    lastChannelInterruptAt = nowMs();
  }

  function sinceLastChannelInterrupt() {
    return lastChannelInterruptAt ? nowMs() - lastChannelInterruptAt : Infinity;
  }

  // The rerun/edit hand-off latch. While set, a second edit/rerun is
  // refused (serialize — overlapping hand-offs are how two live streams
  // get created) and `[data-incipit-handoff]` on <html> greys out every
  // transcript action row via CSS so the buttons visibly read as
  // unavailable instead of looking live but silently no-op'ing.
  function setHandoffLatch(on) {
    historyHandoffInFlight = !!on;
    try {
      const el = document.documentElement;
      if (el) {
        if (on) el.setAttribute('data-incipit-handoff', '1');
        else el.removeAttribute('data-incipit-handoff');
      }
    } catch (_) {}
  }

  function noteTranscriptActionMutation() {
    lastTranscriptMutationAt = nowMs();
    scheduleTranscriptActionSettleScan();
  }

  function scheduleTranscriptActionSettleScan(delay) {
    const wait = typeof delay === 'number' ? Math.max(0, delay) : TRANSCRIPT_ACTION_QUIET_MS;
    if (transcriptActionSettleTimer) clearTimeout(transcriptActionSettleTimer);
    transcriptActionSettleTimer = setTimeout(runTranscriptActionSettleScan, wait);
  }

  // Fix 4 — busy→UI hysteresis. The action-row settle scan must observe
  // `busy` continuously false for BUSY_UI_STABLE_MS before it mints
  // rows. During an interrupt→edit→rerun hand-off (and ordinary
  // send→stop transitions) `busy` can flap several times in a few tens
  // of ms; without this, each flap re-mints the editable action row and
  // re-flips the send/stop icon, which is the visible flicker the user
  // reported. A still-streaming reply never trips this because busy
  // stays true.
  function busyHysteresisReady() {
    if (conversationIsBusy()) { busyFalseStableSince = 0; return false; }
    if (busyFalseStableSince === 0) busyFalseStableSince = nowMs();
    return (nowMs() - busyFalseStableSince) >= BUSY_UI_STABLE_MS;
  }

  function runTranscriptActionSettleScan() {
    transcriptActionSettleTimer = null;

    if (!busyHysteresisReady()) {
      scheduleTranscriptActionSettleScan(TRANSCRIPT_ACTION_BUSY_POLL_MS);
      return;
    }

    const quietFor = nowMs() - lastTranscriptMutationAt;
    if (quietFor < TRANSCRIPT_ACTION_QUIET_MS) {
      scheduleTranscriptActionSettleScan(TRANSCRIPT_ACTION_QUIET_MS - quietFor);
      return;
    }

    runTranscriptActionScanBurst();
  }

  function runTranscriptActionScanBurst() {
    const token = ++transcriptActionBurstToken;
    let frames = 0;

    const scanOnce = () => {
      try { scanAssistantTranscriptActions(document.body); }
      catch (e) { warn('assistant actions failed:', e); }
    };

    // 3 RAF ticks (≈48 ms wall) covers the common case where React
    // commits the final assistant markdown root one frame after the
    // settle scan fires. The 650 ms / 1500 ms setTimeout fallbacks
    // catch late-mounting roots and unmount-then-remount flips. The
    // earlier 14-frame burst was a holdover from when reconcile
    // re-resolved fiber + isLastAssistantOfTurn even for already-
    // decorated rows; that fast-path now exists, so the burst no
    // longer needs to re-amortise its per-frame cost so aggressively.
    const MAX_FRAMES = 3;

    const tick = () => {
      if (token !== transcriptActionBurstToken) return;
      if (!busyHysteresisReady()) {
        scheduleTranscriptActionSettleScan(TRANSCRIPT_ACTION_BUSY_POLL_MS);
        return;
      }
      const quietFor = nowMs() - lastTranscriptMutationAt;
      if (quietFor < TRANSCRIPT_ACTION_QUIET_MS) {
        scheduleTranscriptActionSettleScan(TRANSCRIPT_ACTION_QUIET_MS - quietFor);
        return;
      }
      scanOnce();
      if (++frames < MAX_FRAMES) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    setTimeout(() => {
      if (token === transcriptActionBurstToken && busyHysteresisReady()) scanOnce();
    }, 650);
    setTimeout(() => {
      if (token === transcriptActionBurstToken && busyHysteresisReady()) scanOnce();
    }, 1500);
  }

  // Subscribe to kernel stream/session events to trigger the transcript-action gate.
  // Assistant/tool action rows are not minted directly from streaming
  // mutations anymore. Those mutations only mark the transcript dirty;
  // once the UI is idle and the message DOM has gone quiet, the settle
  // scanner below materialises the final rows in one place.
  let busyStateObserverBound = false;
  let lastBusySeen = false;
  function setupBusyStateObserver() {
    if (busyStateObserverBound) return;
    busyStateObserverBound = true;
    lastBusySeen = conversationIsBusy();
    const cleanupDuringBusy = () => {
      try { sweepStreamingDisableState(); } catch (_) {}
    };
    const trigger = () => {
      const cur = conversationIsBusy();
      if (cur === lastBusySeen) return;  // attr changed but state didn't (send|null|stop|...)
      lastBusySeen = cur;
      if (cur === false) {
        flushDeferredCodeHighlightsIfReady();
      } else {
        // Idle → busy: flip past-turn rows to disabled and remove any
        // tail-row that slipped in during the send/stop transition.
        // Also eagerly clear any active edit hover-preview attr so a
        // user who happened to be hovering the pencil at the moment
        // streaming started doesn't see the draft-bg lingering on a
        // now-disabled icon (mouseenter early-return covers fresh
        // hovers; this handles the hover-in-flight case).
        document.querySelectorAll('[data-incipit-edit-hover-preview]')
          .forEach(el => el.removeAttribute('data-incipit-edit-hover-preview'));
        requestAnimationFrame(cleanupDuringBusy);
      }
    };
    // Only three kernel signals matter for the transcript-action gate:
    //   • busyChanged       — flip disabled state on stream start/stop.
    //   • assistantTurnFinalized — schedule the settle scan after the
    //                         360 ms quiet window (kernel computes it).
    //   • sessionChanged    — invalidate any in-flight settle scan.
    //
    // We deliberately do NOT subscribe to messagesChanged /
    // messagesDomChanged / assistantMarkdownMounted: the typography
    // observer already calls `noteTranscriptActionMutation()` once per
    // mutation batch via the legacy hook, and the kernel events fire
    // per added node — duplicating that channel sent the settle timer
    // through clearTimeout/setTimeout hundreds of times per second
    // during long streams without any extra information.
    subscribeRuntime('busyChanged', trigger);
    subscribeRuntime('assistantTurnFinalized', () => {
      scheduleTranscriptActionSettleScan(0);
    });
    subscribeRuntime('sessionChanged', () => {
      noteTranscriptActionMutation();
    });
  }

  // File drag reference hint.
  //
  // VS Code owns the actual file-drop routing. incipit no longer intercepts
  // drops, prevents defaults, or inserts @ mentions here; doing so needs a
  // workbench-level bridge and that proved too invasive. This is only a
  // localized composer hint for drag events that naturally reach the Claude
  // webview: "hold Shift and drop here to reference the file".
  let fileDragHintBound = false;
  let fileDragHintClearTimer = 0;

  const FILE_DRAG_HINT_TEXT = Object.freeze({
    zh: '按住 Shift 拖放到这里引用文件',
    en: 'Hold Shift and drop here to reference the file',
  });

  function dataTransferTypes(dt) {
    try { return Array.from(dt && dt.types ? dt.types : []); }
    catch (_) { return []; }
  }

  function hasFileishDrag(dt) {
    if (!dt) return false;
    const types = dataTransferTypes(dt).map(t => String(t).toLowerCase());
    if (types.some(t =>
      t === 'files' ||
      t === 'resourceurls' ||
      t === 'codeeditors' ||
      t === 'codefiles' ||
      t === 'application/vnd.code.uri-list' ||
      t === 'text/uri-list'
    )) return true;
    const items = dt.items ? Array.from(dt.items) : [];
    return items.some(item => item && item.kind === 'file');
  }

  const COMPOSER_INPUT_CONTAINER_SELECTOR =
    'fieldset[class*="inputContainer_"], [class*="inputContainer_"]:has(> [class*="inputContainerBackground"])';

  function composerRootSelector() {
    return COMPOSER_INPUT_CONTAINER_SELECTOR;
  }

  function elementClassText(node) {
    if (!node || node.nodeType !== 1) return '';
    return typeof node.className === 'string'
      ? node.className
      : String(node.getAttribute?.('class') || '');
  }

  function hasDirectInputContainerBackground(node) {
    if (!node || node.nodeType !== 1 || !node.children) return false;
    for (const child of node.children) {
      if (elementClassText(child).includes('inputContainerBackground')) return true;
    }
    return false;
  }

  function isComposerRootElement(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      const classes = elementClassText(node);
      if (!classes.includes('inputContainer_')) return false;
      if (classes.includes('inputContainerBackground')) return false;
      const tag = String(node.tagName || '').toLowerCase();
      return tag === 'fieldset' || hasDirectInputContainerBackground(node);
    } catch (_) {
      return false;
    }
  }

  function queryComposerRoots(root, selector) {
    if (!root || !root.querySelectorAll) return [];
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      try { return Array.from(root.querySelectorAll('[class*="inputContainer_"]')); }
      catch (_) { return []; }
    }
  }

  function closestComposerRoot(node) {
    let element = node && node.nodeType === 1 ? node : node?.parentElement;
    while (element) {
      if (isComposerRootElement(element)) return element;
      element = element.parentElement;
    }
    return null;
  }

  function queryComposerRoot(node) {
    const candidates = queryComposerRoots(node, composerRootSelector());
    for (const candidate of candidates) {
      if (isComposerRootElement(candidate)) return candidate;
    }
    return null;
  }

  function currentComposerElement() {
    const candidates = document.querySelectorAll('[class*="inputContainer_"]');
    for (const candidate of candidates) {
      if (isComposerRootElement(candidate)) return candidate;
    }
    return null;
  }

  // Composer mirror geometry is fully host-owned. incipit does NOT sync the
  // mention-mirror visible layer's scroll/padding against the contenteditable.
  //
  // The host composer is two stacked layers: the message-input contenteditable
  // (holds the caret + real text, visually transparent) and the mention-mirror
  // visible text layer. The host keeps their scroll positions in lockstep on its
  // own — in vanilla Claude Code the visible layer scrolls as you type past the
  // fold, which is the host doing the sync. A previous incipit attempt
  // (2026-06-13) copied the editable layer's scrollTop onto the mirror from a
  // characterData/body observer + capture listeners. On paste / programmatic
  // insert (e.g. the Notes insert-mention path) incipit read a stale scrollTop
  // before the browser scrolled to the caret / before React grew the mirror's
  // scrollHeight, wrote a clamped (≈0) value over the host's correct one, and
  // the visible layer drifted from the editable layer until a normal keystroke
  // re-synced it. Fighting the host over this geometry is a lost race; the only
  // correct move is to not touch it (red line 2026-04-15 / 2026-06-06: incipit
  // only feeds input foreground tokens, never owns the input text/scroll/caret
  // layer). The genuinely-needed non-interference fixes stay: global scrollbar
  // CSS excludes composer/contenteditable, the input container box model is
  // untouched, and no padding is added to the visible layer.

  function fileDragHintText() {
    return FILE_DRAG_HINT_TEXT[CFG.language] || FILE_DRAG_HINT_TEXT.en;
  }

  function clearOneFileDragHint(el) {
    if (!el || !el.removeAttribute) return;
    el.removeAttribute('data-incipit-file-drag-hint');
    el.removeAttribute('data-incipit-file-drag-hint-text');
  }

  function setFileDragHintState() {
    const composer = currentComposerElement();
    const current = document.querySelector('[data-incipit-file-drag-hint="over"]');
    if (current && current !== composer) clearOneFileDragHint(current);
    if (!composer) return;
    composer.setAttribute('data-incipit-file-drag-hint', 'over');
    composer.setAttribute('data-incipit-file-drag-hint-text', fileDragHintText());
  }

  function clearFileDragHintState() {
    if (fileDragHintClearTimer) {
      clearTimeout(fileDragHintClearTimer);
      fileDragHintClearTimer = 0;
    }
    document.querySelectorAll('[data-incipit-file-drag-hint]').forEach(clearOneFileDragHint);
  }

  function scheduleFileDragHintClear() {
    if (fileDragHintClearTimer) clearTimeout(fileDragHintClearTimer);
    fileDragHintClearTimer = setTimeout(() => {
      fileDragHintClearTimer = 0;
      clearFileDragHintState();
    }, 900);
  }

  function setupFileDragReferenceHint() {
    if (fileDragHintBound) return;
    fileDragHintBound = true;

    const maybeShow = evt => {
      const dt = evt && evt.dataTransfer;
      if (!hasFileishDrag(dt)) return;
      setFileDragHintState();
      scheduleFileDragHintClear();
    };

    document.addEventListener('dragenter', maybeShow, true);
    document.addEventListener('dragover', maybeShow, true);
    document.addEventListener('dragleave', scheduleFileDragHintClear, true);
    document.addEventListener('dragend', clearFileDragHintState, true);
    document.addEventListener('drop', clearFileDragHintState, true);
    window.addEventListener('blur', clearFileDragHintState);
  }

  // Deferred-next-message card.
  //
  // While Claude is streaming, the host's normal `session.send(...)` is the
  // immediate guidance path. incipit layers one extra mode on top: a normal
  // composer submit is captured into an ordered queue, released one at a
  // time only on a natural turn end. The "Guide" affordance sends a chosen
  // item NOW through the ORIGINAL host send, so the official behavior stays
  // available without a parallel protocol.
  //
  // Bilingual (EN/ZH, driven by CFG.language — same pattern as
  // enhance_footer_badge.js's t()/STR). Each entry is a `{en, zh}` pair
  // instead of a flat string; deferredText() below picks the active
  // language and still handles `{var}` interpolation (counts / sizes /
  // error detail).
  const DEFERRED_NEXT_TEXT = Object.freeze({
    guide: { en: 'Guide', zh: '引导' },
    guideTitle: { en: 'Send now as guidance for the current reply', zh: '立即发送，作为当前回复的引导' },
    removeTitle: { en: 'Remove queued message', zh: '移除排队消息' },
    reorder: { en: 'Hold and drag to reorder', zh: '按住并拖动以重新排序' },
    edit: { en: 'Edit message', zh: '编辑消息' },
    save: { en: 'Save', zh: '保存' },
    cancel: { en: 'Cancel', zh: '取消' },
    attach: { en: 'Attach image', zh: '添加图片' },
    previewImage: { en: 'Click to preview', zh: '点击预览' },
    removeAttachment: { en: 'Remove attachment', zh: '移除附件' },
    empty: { en: 'Nothing to send', zh: '没有可发送的内容' },
    sending: { en: 'Sending follow-up message…', zh: '正在发送后续消息…' },
    imageFallback: { en: 'Image', zh: '图片' },
    imageCount: { en: '{n} images', zh: '{n} 张图片' },
    attachmentCount: { en: '{n} attachments', zh: '{n} 个附件' },
    pasteDrop: { en: 'Paste or drop images', zh: '粘贴或拖放图片' },
    tooLarge: { en: 'Image too large: {size} MB (max 5 MB)', zh: '图片过大：{size} MB（最大 5 MB）' },
    badType: { en: 'Only PNG, JPEG, GIF, and WebP images can be attached', zh: '仅支持添加 PNG、JPEG、GIF 和 WebP 格式的图片' },
    readFail: { en: 'Failed to read image', zh: '读取图片失败' },
    sendFail: { en: 'Follow-up send failed: {msg}', zh: '后续消息发送失败：{msg}' },
  });
  // Image MIME allow-list and size cap are SHARED with the user-bubble
  // inline editor (`ALLOWED_INLINE_IMAGE_MIMES` / `MAX_INLINE_IMAGE_BYTES`,
  // defined later in the same scope). Same concept — "an image attached to
  // a message" — so there is one source of truth, not a parallel copy. The
  // reference resolves at call time (long after module init), so forward
  // use across the IIFE is fine.
  // Generous: an *errored* turn's host "interrupted" marker can render well
  // AFTER busy flips false (user-reported, real machine). Releasing the queue
  // must outlast that lag, so a natural-end decision is gated behind this
  // sustained-quiet confirm window AND re-checked at fire. Do not shrink
  // without re-confirming the error-marker latency — fail-closed by design.
  const DEFERRED_NEXT_NATURAL_CONFIRM_MS = 1500;
  const deferredOriginalSendBySession = new WeakMap();
  let deferredQueue = [];            // ordered; [0] = next to release
  let deferredNextEl = null;
  let deferredInlineError = '';      // surfaced inside the card, never a toast
  let deferredNextSetupBound = false;
  let deferredNextPatchTimer = 0;
  let deferredNextConfirmTimer = 0;
  let deferredNextRenderScheduled = false;
  let deferredNextBypassDepth = 0;
  let deferredNextFlushInFlight = false;
  let deferredNextVisibilityObserver = null;
  let deferredNextSeq = 0;
  let deferredNextPatchAttempts = 0;
  let deferredDragId = null;         // id of the row being pointer-dragged
  let composerRailEl = null;

  // Bilingual (EN/ZH, driven by CFG.language) — see DEFERRED_NEXT_TEXT above.
  const CHANGE_REVIEW_TEXT = Object.freeze({
    rejectTurn: { en: 'Reject turn', zh: '拒绝本轮' },
    rejectFile: { en: 'Reject', zh: '拒绝' },
    subagentLabel: { en: 'Sub-agent', zh: '子代理' },
    filesChanged: { en: '{n} files changed', zh: '{n} 个文件已更改' },
    oneFileChanged: { en: '1 file changed', zh: '1 个文件已更改' },
    showMoreFiles: { en: 'Show {n} more files', zh: '显示另外 {n} 个文件' },
    showMoreFile: { en: 'Show 1 more file', zh: '显示另外 1 个文件' },
    showFewerFiles: { en: 'Show fewer files', zh: '收起文件列表' },
    noFiles: { en: 'No file changes', zh: '没有文件更改' },
    stale: { en: 'Stale', zh: '已过期' },
    rejected: { en: 'Rejected', zh: '已拒绝' },
    unavailable: { en: 'Unavailable', zh: '不可用' },
    close: { en: 'Close', zh: '关闭' },
    openDiff: { en: 'Open diff', zh: '打开差异' },
    loading: { en: 'Loading diff...', zh: '正在加载差异…' },
    rejectFail: { en: 'Reject failed: {msg}', zh: '拒绝失败：{msg}' },
    diffFail: { en: 'Could not open review diff: {msg}', zh: '无法打开审阅差异：{msg}' },
  });
  let changeReviewPayload = null;
  let changeReviewTurnBlockRenderScheduled = false;
  let changeReviewListenerBound = false;
  let changeReviewIdentityTimer = 0;
  let changeReviewStartTimer = 0;
  let changeReviewStartRetryUntil = 0;
  let changeReviewStartedTurnKey = '';
  const CHANGE_REVIEW_VISIBLE_FILE_LIMIT = 3;
  let changeReviewSeq = 0;
  const changeReviewDiffPending = new Map();
  const changeReviewRejectPending = new Map();
  let changeReviewModal = null;
  let changeReviewWriteDiffRenderer = null;

  function registerChangeReviewWriteDiffRenderer(openModal, languageClassForPath) {
    if (typeof openModal !== 'function' || typeof languageClassForPath !== 'function') return;
    changeReviewWriteDiffRenderer = { openModal, languageClassForPath };
  }

  function deferredHead() { return deferredQueue[0] || null; }
  function deferredFindById(id) {
    return deferredQueue.find(it => it && it.id === id) || null;
  }
  function deferredRemoveById(id) {
    const i = deferredQueue.findIndex(it => it && it.id === id);
    if (i >= 0) deferredQueue.splice(i, 1);
    return i >= 0;
  }
  function deferredAnySending() {
    return deferredQueue.some(it => it && it.sending);
  }
  function deferredQueueSessionId() {
    for (const it of deferredQueue) if (it && it.sessionId) return it.sessionId;
    return null;
  }
  function setDeferredInlineError(msg) {
    deferredInlineError = msg ? String(msg) : '';
    scheduleDeferredNextRender();
  }

  // The host paints an explicit "interrupted" marker on a turn stopped by
  // the user OR ended by an error. It is the ONLY thing that distinguishes
  // "did not end naturally" — runtime busy/finalized fire identically for a
  // natural end, a Stop, and an error. partial-tail is a secondary signal
  // (a streaming-cut turn often leaves a partial block). Fail-closed: any
  // doubt ⇒ not natural ⇒ do not release.
  function deferredLastTurnInterrupted() {
    try {
      const msgs = document.querySelectorAll('[class*="timelineMessage"]');
      if (msgs.length) {
        const last = msgs[msgs.length - 1];
        if (last && (last.matches?.('[class*="interruptedMessage"]') ||
                     last.querySelector?.('[class*="interruptedMessage"]'))) return true;
      }
    } catch (_) {}
    try { if (activeSessionHasPartialTail()) return true; } catch (_) {}
    return false;
  }
  function deferredConvBusySafe() {
    // Fail-closed: unknown ⇒ busy. The old catch-based version only covered
    // the kernel-throw branch; the registered probe collapsing all-miss to
    // false slipped past it (2026-06-09). Tri-state closes that hole.
    return conversationBusyOrUnknown();
  }
  function deferredTurnLooksNatural() {
    if (deferredConvBusySafe()) return false;
    if (deferredLastTurnInterrupted()) return false;
    if (askPanelIsActive()) return false;
    return true;
  }
  function cancelNaturalEndConfirm() {
    if (deferredNextConfirmTimer) {
      clearTimeout(deferredNextConfirmTimer);
      deferredNextConfirmTimer = 0;
    }
  }
  // Arm/restart the sustained confirm countdown. Each settle/finalize restarts
  // it; a new busy turn cancels it. Only a window that stays quiet AND natural
  // for its full duration AND still passes the fire-time re-check releases the
  // head — this is what absorbs the lagging error interrupt-marker.
  function armNaturalEndConfirm() {
    if (!deferredQueue.length) return;
    cancelNaturalEndConfirm();
    deferredNextConfirmTimer = setTimeout(() => {
      deferredNextConfirmTimer = 0;
      if (!deferredQueue.length) return;
      if (!deferredTurnLooksNatural()) return;  // interrupted/busy/ask → frozen
      flushDeferredNextIfReady();
    }, DEFERRED_NEXT_NATURAL_CONFIRM_MS);
  }

  function deferredText(key, vars = null) {
    const entry = DEFERRED_NEXT_TEXT[key];
    let text = (entry && (entry[CFG.language] || entry.en)) || key;
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(value));
      }
    }
    return text;
  }

  function signalValue(sig) {
    try {
      return sig && typeof sig === 'object' && 'value' in sig ? sig.value : sig;
    } catch (_) {
      return undefined;
    }
  }

  function sessionIdOf(session) {
    const fromSession = signalValue(session && session.sessionId);
    return typeof fromSession === 'string' && fromSession ? fromSession : getActiveSessionId();
  }

  function sessionIsBusy(session) {
    const busy = signalValue(session && session.busy);
    if (typeof busy === 'boolean') return busy;
    // Only the deferred flush gate consumes this: a session whose busy
    // signal is unreadable must count as busy (fail-closed), not idle.
    return conversationBusyOrUnknown();
  }

  function sessionBusyForDeferredCapture(session) {
    const busy = signalValue(session && session.busy);
    if (busy === true) return true;
    // Fail-closed: when nothing can prove the conversation is idle, a
    // composer submit is captured into the queue (user can still release
    // it manually via Guide) instead of racing a possibly-live stream.
    return conversationBusyOrUnknown();
  }

  function askPanelIsActive() {
    try {
      const containers = document.querySelectorAll(ASK_PERMISSION_CONTAINER_SELECTOR);
      for (const container of containers) {
        if (container.querySelector && container.querySelector(ASK_QUESTIONS_SELECTOR)) return true;
      }
    } catch (_) {}
    return false;
  }

  function nodeInsideFocusedEditor(node) {
    const active = document.activeElement;
    return !!(
      active &&
      active.isContentEditable &&
      node &&
      (node === active || active.contains(node))
    );
  }

  function mutationInsideFocusedEditor(mutation) {
    return !!(mutation && mutation.target && nodeInsideFocusedEditor(mutation.target));
  }

  function nodeTouchesPermissionRequest(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      if (node.matches?.(ASK_PERMISSION_CONTAINER_SELECTOR) ||
          node.matches?.(ASK_QUESTIONS_SELECTOR) ||
          node.closest?.(ASK_PERMISSION_CONTAINER_SELECTOR)) return true;
      return !!(
        node.querySelector?.(ASK_PERMISSION_CONTAINER_SELECTOR) ||
        node.querySelector?.(ASK_QUESTIONS_SELECTOR)
      );
    } catch (_) {}
    return false;
  }

  function nodeInsideMessagesContainer(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      return !!(
        node.matches?.(SEL.messagesContainer) ||
        node.matches?.('[class*="messagesContainer_"]') ||
        node.closest?.(SEL.messagesContainer) ||
        node.closest?.('[class*="messagesContainer_"]')
      );
    } catch (_) {}
    return false;
  }

  function deferredNodeTouchesComposerOrAsk(node) {
    if (!node || node.nodeType !== 1) return false;
    if (nodeInsideFocusedEditor(node)) return false;
    if (nodeTouchesPermissionRequest(node)) return true;
    if (nodeInsideMessagesContainer(node)) return false;
    try {
      if (isComposerRootElement(node)) return true;
      if (closestComposerRoot(node) ||
          queryComposerRoot(node)) return true;
    } catch (_) {}
    return false;
  }

  function deferredComposerIsVisible(input) {
    if (!input || !input.isConnected) return false;
    try {
      const style = window.getComputedStyle ? window.getComputedStyle(input) : null;
      if (style && (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      )) return false;
      if (input.getClientRects && input.getClientRects().length === 0) return false;
    } catch (_) {}
    return true;
  }

  function deferredSessionMatchesItem(session, item) {
    if (!session || !item || !item.sessionId) return false;
    const sessionId = sessionIdOf(session);
    return !sessionId || sessionId === item.sessionId;
  }

  function deferredActiveSessionDiffers(item) {
    if (!item || !item.sessionId) return false;
    const active = locateActiveSessionState();
    return !!(active && !deferredSessionMatchesItem(active, item));
  }

  function deferredCardShouldHide(mount) {
    if (!deferredQueue.length) return true;
    if (!mount || !deferredComposerIsVisible(mount.input)) return true;
    if (askPanelIsActive()) return true;
    const qsid = deferredQueueSessionId();
    if (qsid) {
      const active = locateActiveSessionState();
      const asid = active && sessionIdOf(active);
      if (asid && asid !== qsid) return true;
    }
    return false;
  }

  function normalizeDeferredAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments.filter(att => att && typeof att === 'object').slice();
  }

  function deferredPayloadHasContent(text, attachments) {
    return !!(
      (typeof text === 'string' && text.trim()) ||
      (Array.isArray(attachments) && attachments.length)
    );
  }

  function summarizeDeferredText(text, attachments) {
    const prose = String(text || '').replace(/\s+/g, ' ').trim();
    if (prose) return prose.length > 130 ? prose.slice(0, 127) + '...' : prose;
    const count = Array.isArray(attachments) ? attachments.length : 0;
    if (!count) return deferredText('empty');
    const imageCount = attachments.filter(isImageAttachment).length;
    if (imageCount === count) return deferredText('imageCount', { n: count });
    return deferredText('attachmentCount', { n: count });
  }

  function isImageAttachment(att) {
    const type = String(att?.file?.type || '').toLowerCase();
    return type.startsWith('image/') || /^data:image\//i.test(String(att?.dataUrl || ''));
  }

  function cloneDeferredForEdit(item) {
    return {
      text: String(item && item.text || ''),
      attachments: normalizeDeferredAttachments(item && item.attachments),
    };
  }

  function rawSendForSession(session) {
    if (!session || typeof session.send !== 'function') return null;
    return deferredOriginalSendBySession.get(session) || session.send;
  }

  function captureDeferredNext(session, argsLike) {
    const text = typeof argsLike[0] === 'string' ? argsLike[0] : String(argsLike[0] || '');
    const attachments = normalizeDeferredAttachments(argsLike[1]);
    if (!deferredPayloadHasContent(text, attachments)) return;
    const sessionId = sessionIdOf(session);
    // Append, never replace: the user explicitly wants a multi-message
    // queue. No toast — the persistent card IS the feedback.
    deferredQueue.push({
      id: 'deferred-' + (++deferredNextSeq).toString(36),
      session,
      sessionId,
      text,
      attachments,
      includeSelection: false,
      createdAt: Date.now(),
      editing: false,
      sending: false,
    });
    deferredInlineError = '';
    scheduleDeferredNextRender();
  }

  function shouldCaptureDeferredSend(session, argsLike) {
    if (deferredNextBypassDepth > 0) return false;
    if (!session || typeof session.send !== 'function') return false;
    if (!sessionBusyForDeferredCapture(session)) return false;
    if (!deferredPayloadHasContent(argsLike[0], argsLike[1])) return false;
    return true;
  }

  function wrapDeferredSendOnSession(session) {
    if (!session || typeof session.send !== 'function') return false;
    if (deferredOriginalSendBySession.has(session)) return true;
    const original = session.send;
    deferredOriginalSendBySession.set(session, original);
    session.send = function incipitDeferredNextSendWrapper(...args) {
      if (shouldCaptureDeferredSend(this, args)) {
        captureDeferredNext(this, args);
        return Promise.resolve();
      }
      return original.apply(this, args);
    };
    return true;
  }

  function patchActiveDeferredSession() {
    const session = locateActiveSessionState();
    if (wrapDeferredSendOnSession(session)) {
      deferredNextPatchAttempts = 0;
      reportHealth('legacy.deferred_next.sendWrap', 'ok');
      return true;
    }
    reportHealth('legacy.deferred_next.sendWrap', 'pending', { reason: 'no-active-session' });
    return false;
  }

  function scheduleDeferredSessionPatch(delay = 80) {
    if (deferredNextPatchTimer) return;
    deferredNextPatchTimer = setTimeout(() => {
      deferredNextPatchTimer = 0;
      if (!patchActiveDeferredSession() && ++deferredNextPatchAttempts < 24) {
        scheduleDeferredSessionPatch(650);
      }
    }, delay);
  }

  function composerRailMountPoint() {
    const input = currentComposerElement();
    if (!input || !input.parentElement) return null;
    return { parent: input.parentElement, before: input, input };
  }

  function ensureComposerRail() {
    const mount = composerRailMountPoint();
    if (!mount) {
      if (composerRailEl) {
        try { composerRailEl.remove(); } catch (_) {}
        composerRailEl = null;
      }
      return null;
    }
    if (!composerRailEl || !composerRailEl.isConnected) {
      composerRailEl = document.createElement('div');
      composerRailEl.setAttribute('data-incipit-composer-rail', '');
    }
    if (composerRailEl.parentElement !== mount.parent || composerRailEl.nextSibling !== mount.before) {
      mount.parent.insertBefore(composerRailEl, mount.before);
    }
    composerRailEl.toggleAttribute('data-incipit-composer-rail-hidden',
      !deferredComposerIsVisible(mount.input) || askPanelIsActive());
    return { rail: composerRailEl, input: mount.input };
  }

  function deferredCardMountPoint() {
    const mount = ensureComposerRail();
    if (!mount) return null;
    return { parent: mount.rail, before: null, input: mount.input };
  }

  function removeDeferredNextCard() {
    if (deferredNextEl) {
      try { deferredNextEl.remove(); } catch (_) {}
      deferredNextEl = null;
    }
  }

  function ensureDeferredNextCard() {
    if (!deferredQueue.length) {
      removeDeferredNextCard();
      return null;
    }
    const mount = deferredCardMountPoint();
    if (!mount) {
      removeDeferredNextCard();
      return null;
    }
    if (!deferredNextEl || !deferredNextEl.isConnected) {
      deferredNextEl = document.createElement('div');
      deferredNextEl.setAttribute('data-incipit-deferred-next', '');
    }
    if (deferredNextEl.parentElement !== mount.parent || deferredNextEl.nextSibling !== mount.before) {
      mount.parent.insertBefore(deferredNextEl, mount.before);
    }
    return { el: deferredNextEl, mount };
  }

  function scheduleDeferredNextRender() {
    if (deferredNextRenderScheduled) return;
    deferredNextRenderScheduled = true;
    requestAnimationFrame(() => {
      deferredNextRenderScheduled = false;
      renderDeferredNextCard();
    });
  }

  function makeDeferredIconButton(kind, title, iconSvg, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-incipit-deferred-next-icon-btn', kind);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = iconSvg;
    btn.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      handler(btn, evt);
    });
    return btn;
  }

  // The attachment chips deliberately REUSE the user-bubble inline
  // editor's chip visual language (`incipit-edit-chip*` classes) and its
  // standalone `openImagePreview` modal — same concept, one look, one
  // preview behaviour, zero changes to that battle-tested path. We do
  // NOT reuse its data model (`chips`/JSONL blocks): deferred-next sends
  // composer `{file,dataUrl}` attachments via `session.send`, so the
  // strip is built here against that shape, mirroring `buildChipElement`.
  // The `data-incipit-deferred-next-attachments` attr stays only as the
  // JS hook `refreshDeferredEditorInPlace` queries to swap the strip in
  // place without touching the <textarea> (CJK IME red line).
  function renderDeferredAttachmentStrip(item, editDraft = null) {
    const attachments = editDraft ? editDraft.attachments : item.attachments;
    // Summary (no draft): nothing to show when empty. Editing: always
    // render — the strip carries the '+' add slot even with no images.
    if (!editDraft && (!attachments || !attachments.length)) return null;
    const strip = document.createElement('div');
    strip.className = 'incipit-edit-chip-strip';
    strip.setAttribute('data-incipit-deferred-next-attachments', '');

    (attachments || []).forEach((att, index) => {
      const chip = document.createElement('span');
      chip.className = 'incipit-edit-chip';
      const isImage = isImageAttachment(att);

      if (isImage && att.dataUrl) {
        chip.classList.add('incipit-edit-chip--image');
        const img = document.createElement('img');
        img.className = 'incipit-edit-chip-thumb';
        img.src = att.dataUrl;
        img.alt = att.file && att.file.name ? att.file.name : deferredText('imageFallback');
        img.draggable = false;
        chip.appendChild(img);
        // Click / keyboard → same fullscreen preview as the bubble
        // editor. Guard the X (its own handler stopPropagation's, but a
        // keyboard activation can still bubble here).
        chip.style.cursor = 'zoom-in';
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('aria-label', deferredText('previewImage'));
        chip.title = deferredText('previewImage');
        const preview = ev => {
          if (ev.target && ev.target.closest && ev.target.closest('.incipit-edit-chip-x')) return;
          ev.preventDefault();
          ev.stopPropagation();
          openImagePreview(att.dataUrl);
        };
        chip.addEventListener('click', preview);
        chip.addEventListener('keydown', ev => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          preview(ev);
        });
      } else {
        // Non-image attachment, or an image with no usable data URL:
        // neutral file glyph + label so the user still sees "something
        // is attached" and can remove it (mirrors the bubble fallback).
        const icon = document.createElement('span');
        icon.className = 'incipit-edit-chip-icon';
        icon.innerHTML = CHIP_FILE_ICON_SVG;
        chip.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'incipit-edit-chip-label';
        label.textContent = (att && att.file && att.file.name) || deferredText('imageFallback');
        chip.appendChild(label);
      }

      if (editDraft) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'incipit-edit-chip-x';
        x.setAttribute('aria-label', deferredText('removeAttachment'));
        x.title = deferredText('removeAttachment');
        x.innerHTML = CHIP_X_ICON_SVG;
        x.addEventListener('click', evt => {
          evt.preventDefault();
          evt.stopPropagation();
          editDraft.attachments.splice(index, 1);
          scheduleDeferredNextRender();
        });
        chip.appendChild(x);
      }
      strip.appendChild(chip);
    });

    // Editing: a dashed "empty slot" '+' that opens the file picker —
    // same affordance as the bubble editor, so add lives in the strip,
    // not as a stray button in the action row. Fresh hidden input per
    // render keeps it self-contained across keyed reconciliation.
    if (editDraft) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'incipit-edit-chip-add';
      add.title = deferredText('attach');
      add.setAttribute('aria-label', deferredText('attach'));
      add.innerHTML = CHIP_PLUS_ICON_SVG;
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        for (const file of Array.from(fileInput.files || [])) {
          addDeferredAttachmentFromFile(editDraft, file);
        }
        fileInput.value = '';
      });
      add.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        fileInput.click();
      });
      strip.appendChild(add);
      strip.appendChild(fileInput);
    }
    return strip;
  }

  // Refresh ONLY the attachment strip inside an already-mounted editor,
  // leaving the <textarea> node — its value, caret, and any in-flight CJK
  // IME composition — untouched. Returns false when no live editor is
  // mounted yet, so the caller falls back to a full build.
  function refreshDeferredEditorInPlace(el, item) {
    const row = el.querySelector('[data-incipit-deferred-next-edit]');
    if (!row) return false;
    const textarea = row.querySelector('[data-incipit-deferred-next-textarea]');
    if (!textarea || !textarea.isConnected) return false;
    const draft = item.editDraft || (item.editDraft = cloneDeferredForEdit(item));
    const existing = row.querySelector('[data-incipit-deferred-next-attachments]');
    const fresh = renderDeferredAttachmentStrip(item, draft);
    if (existing && fresh) row.replaceChild(fresh, existing);
    else if (existing && !fresh) existing.remove();
    else if (!existing && fresh) {
      const actions = row.querySelector('[data-incipit-deferred-next-edit-actions]');
      if (actions) row.insertBefore(fresh, actions);
      else row.appendChild(fresh);
    }
    return true;
  }

  // Keyed-by-id list reconciliation. The list container and each row node
  // PERSIST across renders so a row never detaches — detaching the row that
  // holds the live editor would cancel CJK IME composition (the 2026-04-15
  // red line). Summary rows are stateless → rebuilt freely; the editing row
  // is kept and only its strip refreshed in place. Reorder is a pure node
  // move, not a teardown.
  function deferredRowFor(list, item) {
    let row = list.querySelector('[data-incipit-deferred-id="' + item.id + '"]');
    if (!row) {
      row = document.createElement('div');
      row.setAttribute('data-incipit-deferred-row', '');
      row.setAttribute('data-incipit-deferred-id', item.id);
      list.appendChild(row);
    }
    row.toggleAttribute('data-incipit-deferred-next-sending', !!item.sending);
    const hasEditor = !!row.querySelector('[data-incipit-deferred-next-edit]');
    if (item.editing) {
      if (hasEditor) refreshDeferredEditorInPlace(row, item); // keep textarea/IME
      else { row.textContent = ''; renderDeferredNextEditor(row, item); }
    } else {
      row.textContent = '';                                   // summary is stateless
      renderDeferredNextSummary(row, item);
    }
    return row;
  }

  function renderDeferredNextCard() {
    const ensured = ensureDeferredNextCard();
    if (!ensured) return;
    const { el, mount } = ensured;
    if (!deferredQueue.length) { el.textContent = ''; return; }
    el.toggleAttribute('data-incipit-deferred-next-hidden', deferredCardShouldHide(mount));

    let list = el.querySelector('[data-incipit-deferred-next-list]');
    if (!list) {
      el.textContent = '';
      list = document.createElement('div');
      list.setAttribute('data-incipit-deferred-next-list', '');
      el.appendChild(list);
    }
    let errEl = el.querySelector('[data-incipit-deferred-next-error]');
    if (deferredInlineError) {
      if (!errEl) {
        errEl = document.createElement('div');
        errEl.setAttribute('data-incipit-deferred-next-error', '');
        el.insertBefore(errEl, list);
      }
      errEl.textContent = deferredInlineError;
    } else if (errEl) {
      errEl.remove();
    }

    const wanted = deferredQueue.map(item => deferredRowFor(list, item));
    const wantedSet = new Set(wanted);
    wanted.forEach((row, i) => {
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    });
    Array.from(list.children).forEach(ch => { if (!wantedSet.has(ch)) ch.remove(); });
  }

  function changeReviewText(key, vars = null) {
    const entry = CHANGE_REVIEW_TEXT[key];
    let text = (entry && (entry[CFG.language] || entry.en)) || key;
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), String(value));
      }
    }
    return text;
  }

  function changeReviewTurnFiles(turn) {
    return (turn && Array.isArray(turn.files) ? turn.files : [])
      .filter(file => file);
  }

  function changeReviewFilePath(file) {
    if (!file) return '';
    return file.displayPath || file.filePath || '';
  }

  // Capture rejected file DETAILS BEFORE posting the reject — the response
  // payload already has them removed, so the notes reject-reminder bubble could
  // not read them after the fact. Each entry carries enough for a per-file,
  // tool-aware reminder line. NB: no edit line ranges — after a revert the model
  // sees the restored old file, so new-version line numbers would mislead it;
  // only the tool, created/restored outcome, and +N/-M totals are reported (see
  // footer_badge buildRejectReminder). isCreated/added/removed/hasLineStats come
  // straight off the host payload; `tool` is the field host-badge now threads
  // through from editActivityFromToolUse.
  function changeReviewFileRejectInfo(file) {
    if (!file) return null;
    const path = changeReviewFilePath(file);
    if (!path) return null;
    return {
      path,
      tool: typeof file.tool === 'string' ? file.tool : '',
      isCreated: file.isCreated === true,
      added: Number.isFinite(file.added) ? file.added : 0,
      removed: Number.isFinite(file.removed) ? file.removed : 0,
      hasLineStats: file.hasLineStats === true,
    };
  }

  function changeReviewTurnRejectedFiles(turnKey) {
    const turn = changeReviewTurns().find(t => t && t.turnKey === turnKey);
    if (!turn) return [];
    return changeReviewTurnFiles(turn).map(changeReviewFileRejectInfo).filter(Boolean);
  }

  function changeReviewRejectedFilesByIds(fileIds) {
    const want = new Set(fileIds);
    const out = [];
    for (const turn of changeReviewTurns()) {
      for (const file of changeReviewTurnFiles(turn)) {
        if (file && want.has(file.id)) {
          const info = changeReviewFileRejectInfo(file);
          if (info) out.push(info);
        }
      }
    }
    return out;
  }

  // Bridge change-review reject -> the footer notes icon (separate module) via a
  // window event, so the two stay decoupled. Only fired on a successful reject.
  function dispatchChangeReviewRejected(files) {
    const clean = (Array.isArray(files) ? files : [])
      .filter(f => f && typeof f.path === 'string' && f.path);
    if (!clean.length) return;
    try {
      window.dispatchEvent(new CustomEvent('incipit:change-review-rejected', { detail: { files: clean } }));
    } catch (_) {}
  }

  function changeReviewTurnSummary(turn) {
    const summary = turn && turn.summary && typeof turn.summary === 'object'
      ? turn.summary
      : null;
    return summary && changeReviewNumber(summary.files) > 0 ? summary : null;
  }

  function changeReviewNumber(value) {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function changeReviewTurnFileCount(turn) {
    const totals = turn && turn.totals && typeof turn.totals === 'object'
      ? turn.totals
      : null;
    return totals ? changeReviewNumber(totals.files) : changeReviewTurnFiles(turn).length;
  }

  function changeReviewRejectableFiles(turn) {
    return changeReviewTurnFiles(turn)
      .filter(file => !file.status || file.status === 'pending');
  }

  function changeReviewTotals(turn) {
    const turnTotals = turn && turn.totals && typeof turn.totals === 'object'
      ? turn.totals
      : null;
    if (turnTotals) {
      return {
        files: changeReviewNumber(turnTotals.files),
        added: changeReviewNumber(turnTotals.added),
        removed: changeReviewNumber(turnTotals.removed),
      };
    }
    const files = changeReviewTurnFiles(turn);
    return files.reduce((sum, file) => {
      sum.files += 1;
      sum.added += file.added || 0;
      sum.removed += file.removed || 0;
      return sum;
    }, { files: 0, added: 0, removed: 0 });
  }

  function changeReviewFileHasLineStats(file) {
    return !!(file && file.hasLineStats === true);
  }

  function changeReviewSummaryHasLineStats(summary) {
    return !!(summary && summary.hasLineStats === true);
  }

  function changeReviewTotalsHaveLineStats(turn) {
    if (turn && turn.totals && turn.totals.hasLineStats === true) return true;
    return changeReviewTurnFiles(turn).some(changeReviewFileHasLineStats);
  }

  function formatChangeReviewSummary(turn) {
    const totals = changeReviewTotals(turn);
    const label = totals.files === 1
      ? changeReviewText('oneFileChanged')
      : changeReviewText('filesChanged', { n: totals.files });
    return label;
  }

  function appendChangeReviewLineStats(parent, added, removed) {
    if (!parent) return;
    const add = document.createElement('span');
    add.setAttribute('data-incipit-tool-added', '');
    add.textContent = '+' + changeReviewNumber(added);
    const del = document.createElement('span');
    del.setAttribute('data-incipit-tool-removed', '');
    del.textContent = '\u2212' + changeReviewNumber(removed);
    parent.appendChild(add);
    parent.appendChild(del);
  }

  function changeReviewButton(label, attr) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(attr, '');
    btn.textContent = label;
    // No click handler here: reject actions are delegated to the stable
    // turn block (bindChangeReviewBlockDelegation). A handler bound on this
    // per-render button can be destroyed by a legitimate payload-changing
    // rebuild between mousedown and mouseup, dropping clicks.
    return btn;
  }

  function scheduleChangeReviewTurnBlocksRender() {
    if (changeReviewTurnBlockRenderScheduled) return;
    changeReviewTurnBlockRenderScheduled = true;
    requestAnimationFrame(() => {
      changeReviewTurnBlockRenderScheduled = false;
      renderChangeReviewTurnBlocks();
    });
  }

  function renderChangeReviewFileRow(file, options = {}) {
    const row = document.createElement('div');
    row.setAttribute('data-incipit-change-review-file', '');
    row.setAttribute('data-incipit-change-review-source', 'main');
    row.setAttribute('data-incipit-change-review-clickable', '1');
    row.dataset.incipitChangeReviewFileId = file.id || '';
    const name = document.createElement('button');
    name.type = 'button';
    name.setAttribute('data-incipit-change-review-file-name', '');
    name.textContent = file.displayPath || file.filePath || 'file';
    // Open-diff click is delegated to the stable turn block
    // (bindChangeReviewBlockDelegation), keyed by the row's fileId dataset,
    // so it survives the host-poll rebuild that destroys this row.
    row.appendChild(name);

    const counts = document.createElement('span');
    counts.setAttribute('data-incipit-change-review-counts', '');
    if (changeReviewFileHasLineStats(file)) {
      appendChangeReviewLineStats(counts, file.added, file.removed);
    }
    row.appendChild(counts);

    if (file.status && file.status !== 'pending') {
      const status = document.createElement('span');
      status.setAttribute('data-incipit-change-review-status', file.status);
      status.textContent = changeReviewStatusLabel(file.status);
      row.appendChild(status);
    }

    const reject = changeReviewButton(changeReviewText('rejectFile'), 'data-incipit-change-review-reject-file');
    reject.disabled = !!options.busy || file.status === 'rejected' || file.status === 'stale' || file.status === 'unavailable';
    if (reject.disabled) reject.dataset.incipitDisabled = '1';
    row.appendChild(reject);
    return row;
  }

  function formatChangeReviewSummaryFileLabel(summary) {
    const files = changeReviewNumber(summary && summary.files);
    return files === 1
      ? changeReviewText('oneFileChanged')
      : changeReviewText('filesChanged', { n: files });
  }

  function renderChangeReviewSummaryRow(summary) {
    const row = document.createElement('div');
    row.setAttribute('data-incipit-change-review-file', '');
    row.setAttribute('data-incipit-change-review-source', summary && summary.source || 'subagent');

    const name = document.createElement('span');
    name.setAttribute('data-incipit-change-review-file-name', '');
    name.setAttribute('data-incipit-change-review-summary-name', '');
    name.textContent = formatChangeReviewSummaryFileLabel(summary);
    row.appendChild(name);

    const badge = document.createElement('span');
    badge.setAttribute('data-incipit-change-review-subagent-badge', '');
    badge.textContent = summary && summary.sourceLabel || changeReviewText('subagentLabel');
    row.appendChild(badge);

    const counts = document.createElement('span');
    counts.setAttribute('data-incipit-change-review-counts', '');
    if (changeReviewSummaryHasLineStats(summary)) {
      appendChangeReviewLineStats(counts, summary.added, summary.removed);
    }
    row.appendChild(counts);

    return row;
  }

  function renderChangeReviewMoreRow(block, turn, hiddenCount, expanded) {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('data-incipit-change-review-more', '');
    row.textContent = expanded
      ? changeReviewText('showFewerFiles')
      : changeReviewText(hiddenCount === 1 ? 'showMoreFile' : 'showMoreFiles', { n: hiddenCount });
    // No per-row click handler: the toggle is delegated to the stable
    // turn block (bindChangeReviewBlockDelegation). Per-render handlers
    // are lost if a payload-changing rebuild lands mid-interaction.
    return row;
  }

  // ALL change-review block interactions are delegated to the stable turn
  // block, bound ONCE on creation. The block element is reused across
  // renders by turnKey, so this listener survives every child rebuild — and
  // because the browser dispatches click to the common ancestor of
  // mousedown/mouseup, even an inner button legitimately rebuilt between
  // press and release still resolves here. Binding handlers on the
  // per-render buttons instead dropped clicks that landed during a
  // payload-changing host update ("expand/reject/open-diff sometimes does
  // nothing"). All four affordances (show-more, reject turn, reject file,
  // open diff) route through here; the dataset/attr on the clicked node is
  // the key.
  function bindChangeReviewBlockDelegation(block) {
    const liveTurn = () => {
      const turnKey = block.getAttribute('data-incipit-change-review-turn') || '';
      return changeReviewTurns().find(t => t && t.turnKey === turnKey) || null;
    };
    block.addEventListener('click', evt => {
      const t = evt.target;
      if (!t || !t.closest) return;
      const within = el => !!el && block.contains(el);

      // Show-more / show-less toggle.
      const more = t.closest('[data-incipit-change-review-more]');
      if (within(more)) {
        evt.preventDefault();
        evt.stopPropagation();
        const turn = liveTurn();
        if (!turn) return;
        if (block.dataset.incipitChangeReviewExpanded === '1') {
          delete block.dataset.incipitChangeReviewExpanded;
        } else {
          block.dataset.incipitChangeReviewExpanded = '1';
        }
        updateChangeReviewTurnBlock(block, turn);
        return;
      }

      // Reject the whole turn.
      const rejectTurn = t.closest('[data-incipit-change-review-reject-turn]');
      if (within(rejectTurn)) {
        evt.preventDefault();
        evt.stopPropagation();
        if (rejectTurn.disabled || rejectTurn.dataset.incipitDisabled === '1') return;
        const turn = liveTurn();
        if (turn) rejectChangeReviewTurn(turn.turnKey, rejectTurn);
        return;
      }

      // Reject a single file.
      const rejectFile = t.closest('[data-incipit-change-review-reject-file]');
      if (within(rejectFile)) {
        evt.preventDefault();
        evt.stopPropagation();
        if (rejectFile.disabled || rejectFile.dataset.incipitDisabled === '1') return;
        const fileRow = rejectFile.closest('[data-incipit-change-review-file]');
        const fileId = fileRow && fileRow.dataset.incipitChangeReviewFileId;
        if (fileId) rejectChangeReviewFile(fileId, rejectFile);
        return;
      }

      // Open the diff for a concrete file row. Summary rows carry the same
      // attr but no fileId, so they fall through (no fake diff).
      const fileRow = t.closest('[data-incipit-change-review-file]');
      if (within(fileRow)) {
        const fileId = fileRow.dataset.incipitChangeReviewFileId;
        if (!fileId) return;
        evt.preventDefault();
        evt.stopPropagation();
        const turn = liveTurn();
        const files = turn && Array.isArray(turn.files) ? turn.files : [];
        const file = files.find(f => f && f.id === fileId);
        if (file) openChangeReviewDiff(file);
      }
    });
  }

  function changeReviewStatusLabel(status) {
    if (status === 'stale') return changeReviewText('stale');
    if (status === 'rejected') return changeReviewText('rejected');
    if (status === 'unavailable') return changeReviewText('unavailable');
    return status || '';
  }

  function changeReviewBusySafe() {
    // Read-only / visual: gates WHEN the finalized review block renders,
    // never whether files change. Fail-open (unknown ⇒ idle) so a broken
    // probe surface cannot permanently brick review rendering; the
    // busy-resume sweep already retracts a block minted into a live turn.
    return conversationIsBusy();
  }

  function cssEscapeAttr(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value || ''));
    return String(value || '').replace(/"/g, '\\"');
  }

  function changeReviewTurns() {
    return changeReviewPayload && Array.isArray(changeReviewPayload.turns)
      ? changeReviewPayload.turns
      : [];
  }

  function changeReviewTurnKeyForLastAssistant() {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || !messages.length) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'progress' || m.type === 'system') continue;
      if (m.type === 'user' && transcriptHasToolResult(m)) continue;
      if (m.type !== 'assistant') return '';
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j];
        if (!prev || typeof prev !== 'object') continue;
        if (prev.type === 'user' && transcriptHasToolResult(prev)) continue;
        if (prev.type === 'assistant' || prev.type === 'progress' || prev.type === 'system') continue;
        if (prev.type !== 'user') return '';
        return recordUuid(prev);
      }
      return '';
    }
    return '';
  }

  function changeReviewTurnKeyForLatestRealUser() {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || !messages.length) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'progress' || m.type === 'system') continue;
      if (m.type === 'user' && transcriptHasToolResult(m)) continue;
      if (m.type === 'assistant') {
        if (transcriptHasText(m)) return '';
        continue;
      }
      if (m.type === 'user') return recordUuid(m);
      return '';
    }
    return '';
  }

  function removeCurrentBusyChangeReviewTurnBlocks() {
    if (!changeReviewBusySafe()) return;
    const turnKey = latestRealUserTurnKey();
    if (!turnKey) return;
    document.querySelectorAll('[data-incipit-change-review-turn]').forEach(block => {
      if ((block.getAttribute('data-incipit-change-review-turn') || '') === turnKey) {
        block.remove();
      }
    });
  }

  function postChangeReviewTurnLifecycle(type, turnKey) {
    if (!turnKey) return;
    setupChangeReviewChannel();
    const api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') return;
    try {
      api.postMessage({
        __incipit: true,
        type,
        sessionId: getActiveSessionId(),
        cwd: getActiveSessionCwd() || (changeReviewPayload && changeReviewPayload.cwd) || null,
        turnKey,
      });
    } catch (_) {}
  }

  function notifyChangeReviewTurnStarted() {
    const turnKey = changeReviewTurnKeyForLatestRealUser();
    if (!turnKey) return false;
    if (turnKey === changeReviewStartedTurnKey) return true;
    changeReviewStartedTurnKey = turnKey;
    postChangeReviewTurnLifecycle('change_review_turn_started', turnKey);
    return true;
  }

  function cancelChangeReviewTurnStarted() {
    changeReviewStartRetryUntil = 0;
    if (changeReviewStartTimer) {
      clearTimeout(changeReviewStartTimer);
      changeReviewStartTimer = 0;
    }
  }

  function scheduleChangeReviewTurnStarted(delay = 60) {
    if (changeReviewStartTimer) clearTimeout(changeReviewStartTimer);
    changeReviewStartTimer = setTimeout(() => {
      changeReviewStartTimer = 0;
      if (notifyChangeReviewTurnStarted()) return;
      if (changeReviewBusySafe() && nowMs() < changeReviewStartRetryUntil) {
        scheduleChangeReviewTurnStarted(80);
      }
    }, delay);
  }

  function armChangeReviewTurnStarted() {
    changeReviewStartRetryUntil = nowMs() + 1800;
    scheduleChangeReviewTurnStarted(40);
  }

  function notifyChangeReviewTurnFinalized() {
    postChangeReviewTurnLifecycle('change_review_turn_finalized', changeReviewTurnKeyForLastAssistant());
  }

  function findAssistantRecordForTurn(turnKey) {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || !turnKey) return null;
    const userIdx = messages.findIndex(m => m && m.type === 'user' && recordUuid(m) === turnKey);
    if (userIdx < 0) return null;
    let fallback = null;
    for (let i = userIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'user' && !transcriptHasToolResult(m)) break;
      if (m.type === 'assistant' && transcriptHasText(m)) {
        fallback = m;
        if (isLastAssistantOfTurn(m)) return m;
      }
    }
    return fallback;
  }

  function findAssistantReviewPlacement(record) {
    if (!record) return null;
    const markdownRoot = lastAssistantMarkdownRoot(record);
    if (markdownRoot) {
      const host = findAssistantActionHost(markdownRoot) || closestByAttr(markdownRoot, ATTR.message);
      if (host && host.querySelector(':scope > .incipit-assistant-action-row')) return { host, markdownRoot };
    }
    const hosts = document.querySelectorAll(SEL.message + ', [class*="timelineMessage"]');
    for (const host of hosts) {
      if (host.closest(SEL.userMessageContainer) || host.closest('[class*="userMessageContainer"]')) continue;
      if (!host.querySelector(':scope > .incipit-assistant-action-row')) continue;
      const rec = transcriptRecordForElement(host);
      if (sameTranscriptRecord(rec, record)) return { host, markdownRoot: null };
    }
    const roots = document.querySelectorAll(SEL.markdownRoot + ', [class*="root_"]');
    for (const root of roots) {
      const rec = transcriptRecordForElement(root);
      if (!sameTranscriptRecord(rec, record)) continue;
      const host = findAssistantActionHost(root) || closestByAttr(root, ATTR.message);
      if (host && host.querySelector(':scope > .incipit-assistant-action-row')) return { host, markdownRoot: root };
    }
    return null;
  }

  function placeChangeReviewTurnBlock(host, block) {
    if (!host || !block) return false;
    const actionRow = host.querySelector(':scope > .incipit-assistant-action-row');
    if (!actionRow) return false;
    if (actionRow.nextSibling !== block) host.insertBefore(block, actionRow.nextSibling);
    return true;
  }

  function renderChangeReviewTurnBlocks() {
    if (changeReviewBusySafe()) {
      removeCurrentBusyChangeReviewTurnBlocks();
      return;
    }
    const turns = changeReviewTurns();
    const wanted = new Set(turns.map(turn => turn && turn.turnKey).filter(Boolean));
    document.querySelectorAll('[data-incipit-change-review-turn]').forEach(block => {
      const key = block.getAttribute('data-incipit-change-review-turn') || '';
      if (!wanted.has(key)) block.remove();
    });
    if (!turns.length) return;
    for (const turn of turns) {
      if (changeReviewTurnFileCount(turn) <= 0) continue;
      const record = findAssistantRecordForTurn(turn.turnKey);
      const placement = findAssistantReviewPlacement(record);
      let block = document.querySelector('[data-incipit-change-review-turn="' + cssEscapeAttr(turn.turnKey) + '"]');
      if (!placement || !placement.host) {
        if (block) block.remove();
        continue;
      }
      const host = placement.host;
      if (!block) {
        block = document.createElement('div');
        block.setAttribute('data-incipit-change-review-turn', turn.turnKey);
        bindChangeReviewBlockDelegation(block);
      }
      if (!placeChangeReviewTurnBlock(host, block)) continue;
      updateChangeReviewTurnBlock(block, turn);
    }
  }

  function updateChangeReviewTurnBlock(block, turn) {
    const busy = changeReviewBusySafe();
    const expanded = block.dataset.incipitChangeReviewExpanded === '1';
    // Build the new subtree OFF-DOM, then swap it into the live block only
    // when it actually differs from what's already rendered. The block
    // lives inside the messages container watched by the typography
    // MutationObserver; an unconditional `block.textContent=''` rebuild
    // emits a childList mutation that wakes noteTranscriptActionMutation →
    // settle scan → reconcileAssistantTranscriptActions → placeAssistant-
    // ActionRow → scheduleChangeReviewTurnBlocksRender → back here, a
    // self-sustaining ~360 ms loop (TRANSCRIPT_ACTION_QUIET_MS) that tore
    // the hovered child down and rebuilt it every cycle — the frantic
    // hover/non-hover flicker the user saw on the review block. Comparing
    // the freshly built HTML to the live one short-circuits the no-op
    // re-render, which breaks that loop and preserves the hovered/focused
    // node. The rendered HTML is its own signature, so it can never drift
    // out of sync with the render logic the way a hand-kept field list would.
    const next = document.createElement('div');
    const header = document.createElement('div');
    header.setAttribute('data-incipit-change-review-turn-header', '');
    const title = document.createElement('div');
    title.setAttribute('data-incipit-change-review-turn-title', '');
    const titleLabel = document.createElement('span');
    titleLabel.setAttribute('data-incipit-change-review-title-label', '');
    titleLabel.textContent = formatChangeReviewSummary(turn);
    title.appendChild(titleLabel);
    if (changeReviewTotalsHaveLineStats(turn)) {
      const totals = changeReviewTotals(turn);
      appendChangeReviewLineStats(title, totals.added, totals.removed);
    }
    header.appendChild(title);
    const reject = changeReviewButton(changeReviewText('rejectTurn'), 'data-incipit-change-review-reject-turn');
    reject.disabled = busy || changeReviewRejectableFiles(turn).length <= 0;
    if (reject.disabled) reject.dataset.incipitDisabled = '1';
    header.appendChild(reject);
    next.appendChild(header);

    const files = changeReviewTurnFiles(turn);
    const summary = changeReviewTurnSummary(turn);
    if (files.length || summary) {
      const list = document.createElement('div');
      list.setAttribute('data-incipit-change-review-turn-files', '');
      const visibleFiles = expanded ? files : files.slice(0, CHANGE_REVIEW_VISIBLE_FILE_LIMIT);
      for (const file of visibleFiles) {
        list.appendChild(renderChangeReviewFileRow(file, { busy }));
      }
      const hiddenCount = Math.max(0, files.length - visibleFiles.length);
      if (hiddenCount > 0 || (expanded && files.length > CHANGE_REVIEW_VISIBLE_FILE_LIMIT)) {
        list.appendChild(renderChangeReviewMoreRow(block, turn, hiddenCount, expanded));
      }
      if (summary) list.appendChild(renderChangeReviewSummaryRow(summary));
      next.appendChild(list);
    }

    // Idempotent swap: identical render ⇒ leave the live DOM untouched (no
    // mutation, no observer wake, hovered node survives). See block comment.
    if (next.innerHTML === block.innerHTML) return;
    block.textContent = '';
    while (next.firstChild) block.appendChild(next.firstChild);
  }

  function setupChangeReviewChannel() {
    if (changeReviewListenerBound) return;
    changeReviewListenerBound = true;
    window.addEventListener('message', evt => {
      const msg = evt && evt.data;
      if (msg && msg.__incipitChangeReview === true && msg.payload) {
        changeReviewPayload = msg.payload;
        if (!changeReviewBusySafe()) scheduleChangeReviewTurnBlocksRender();
        return;
      }
      if (!msg || msg.__incipit !== true) return;
      if (msg.type === 'change_review_diff_response') {
        const pending = changeReviewDiffPending.get(msg.requestId);
        if (!pending) return;
        changeReviewDiffPending.delete(msg.requestId);
        const payload = msg.payload || {};
        if (payload.ok === false) pending.reject(new Error(payload.error || 'Diff request failed'));
        else pending.resolve(payload);
        return;
      }
      if (msg.type === 'change_review_reject_response') {
        const pending = changeReviewRejectPending.get(msg.requestId);
        if (!pending) return;
        changeReviewRejectPending.delete(msg.requestId);
        const payload = msg.payload || {};
        if (payload.payload) changeReviewPayload = payload.payload;
        if (payload.ok === false) pending.reject(new Error(payload.error || firstRejectError(payload) || 'Reject failed'));
        else pending.resolve(payload);
        scheduleChangeReviewTurnBlocksRender();
      }
    });
  }

  function firstRejectError(payload) {
    const list = Array.isArray(payload && payload.results) ? payload.results : [];
    const hit = list.find(item => item && item.error);
    return hit ? hit.error : '';
  }

  function postChangeReviewRequest(type, payload, timeoutMs = 10000) {
    setupChangeReviewChannel();
    const api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') {
      return Promise.reject(new Error('Could not reach the VS Code webview channel.'));
    }
    const requestId = 'review-' + (++changeReviewSeq).toString(36);
    const pending = type === 'change_review_diff_request' ? changeReviewDiffPending : changeReviewRejectPending;
    const message = {
      __incipit: true,
      type,
      requestId,
      sessionId: getActiveSessionId(),
      cwd: getActiveSessionCwd() || (changeReviewPayload && changeReviewPayload.cwd) || null,
      busy: changeReviewBusySafe(),
      ...payload,
    };
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        api.postMessage(message);
      } catch (error) {
        pending.delete(requestId);
        reject(error);
        return;
      }
      setTimeout(() => {
        const item = pending.get(requestId);
        if (!item) return;
        pending.delete(requestId);
        item.reject(new Error('Change review request timed out.'));
      }, timeoutMs);
    });
  }

  function requestChangeReviewIdentity() {
    setupChangeReviewChannel();
    const api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') return;
    try {
      api.postMessage({
        __incipit: true,
        type: 'change_review_identity_update',
        sessionId: getActiveSessionId(),
        cwd: getActiveSessionCwd() || null,
      });
    } catch (_) {}
  }

  function scheduleChangeReviewIdentityUpdate(delay = 100) {
    if (changeReviewIdentityTimer) clearTimeout(changeReviewIdentityTimer);
    changeReviewIdentityTimer = setTimeout(() => {
      changeReviewIdentityTimer = 0;
      requestChangeReviewIdentity();
    }, delay);
  }

  function rejectChangeReviewTurn(turnKey, button) {
    if (!turnKey || changeReviewBusySafe()) return;
    if (button) button.dataset.incipitInflight = '1';
    const files = changeReviewTurnRejectedFiles(turnKey);
    postChangeReviewRequest('change_review_reject_request', { turnKey })
      .then(() => { dispatchChangeReviewRejected(files); })
      .catch(error => {
        warn('change review reject failed:', error && error.message ? error.message : error);
      })
      .finally(() => {
        if (button) button.removeAttribute('data-incipit-inflight');
        scheduleChangeReviewTurnBlocksRender();
      });
  }

  function rejectChangeReviewFile(fileId, button) {
    if (!fileId || changeReviewBusySafe()) return;
    if (button) button.dataset.incipitInflight = '1';
    const files = changeReviewRejectedFilesByIds([fileId]);
    postChangeReviewRequest('change_review_reject_request', { fileId })
      .then(() => { dispatchChangeReviewRejected(files); })
      .catch(error => {
        warn('change review reject failed:', error && error.message ? error.message : error);
      })
      .finally(() => {
        if (button) button.removeAttribute('data-incipit-inflight');
        scheduleChangeReviewTurnBlocksRender();
      });
  }

  function openChangeReviewDiff(file) {
    if (!file || !file.id) return;
    openChangeReviewModalShell(file.displayPath || file.filePath || 'diff', changeReviewText('loading'));
    postChangeReviewRequest('change_review_diff_request', { fileId: file.id }, 12000)
      .then(payload => {
        const diff = payload.diff || {};
        openChangeReviewDiffModal(payload.file || file, diff);
      })
      .catch(error => {
        openChangeReviewModalShell(file.displayPath || file.filePath || 'diff',
          changeReviewText('diffFail', { msg: error && error.message ? error.message : String(error) }));
      });
  }

  function closeChangeReviewModal() {
    if (!changeReviewModal) return;
    const modal = changeReviewModal;
    changeReviewModal = null;
    document.removeEventListener('keydown', modal.onKeyDown, true);
    if (modal.backdrop && modal.backdrop.parentElement) modal.backdrop.remove();
  }

  function openChangeReviewModalShell(titleText, bodyText) {
    closeChangeReviewModal();
    if (!document.body) return;
    const backdrop = document.createElement('div');
    backdrop.setAttribute('data-incipit-change-review-modal', '');
    const content = document.createElement('div');
    content.setAttribute('data-incipit-write-diff-modal-content', '');
    content.setAttribute('data-incipit-change-review-modal-content', '');
    const header = document.createElement('div');
    header.setAttribute('data-incipit-write-diff-modal-header', '');
    const title = document.createElement('span');
    title.setAttribute('data-incipit-write-diff-modal-title', '');
    title.textContent = titleText || legacyText('diff_fallback_title');
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('data-incipit-write-diff-modal-close', '');
    close.setAttribute('aria-label', changeReviewText('close'));
    close.textContent = '\u00d7';
    close.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      closeChangeReviewModal();
    });
    header.appendChild(title);
    header.appendChild(close);
    const body = document.createElement('div');
    body.setAttribute('data-incipit-change-review-modal-message', '');
    body.textContent = bodyText || '';
    content.appendChild(header);
    content.appendChild(body);
    backdrop.appendChild(content);
    backdrop.addEventListener('click', evt => {
      if (evt.target !== backdrop) return;
      evt.preventDefault();
      closeChangeReviewModal();
    });
    const onKeyDown = evt => {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      closeChangeReviewModal();
    };
    document.addEventListener('keydown', onKeyDown, true);
    changeReviewModal = { backdrop, onKeyDown, content };
    document.body.appendChild(backdrop);
  }

  function openChangeReviewDiffModal(file, diff) {
    const renderer = changeReviewWriteDiffRenderer;
    const title =
      (file && (file.displayPath || file.filePath)) ||
      (diff && (diff.displayPath || diff.filePath)) ||
      'diff';
    if (!renderer) {
      openChangeReviewModalShell(title, changeReviewText('diffFail', { msg: 'diff renderer unavailable' }));
      return;
    }
    const filePath =
      (diff && (diff.filePath || diff.displayPath)) ||
      (file && (file.filePath || file.displayPath)) ||
      '';
    const payload = {
      filePath,
      oldText: diff && typeof diff.oldText === 'string' ? diff.oldText : '',
      newText: diff && typeof diff.newText === 'string' ? diff.newText : '',
    };
    if (diff && Array.isArray(diff.rows)) payload.rows = diff.rows;
    const lineInfo = diff && (diff.oldStartLine || diff.newStartLine || diff.startLine)
      ? {
          oldStartLine: diff.oldStartLine || diff.startLine || 1,
          newStartLine: diff.newStartLine || diff.startLine || 1,
        }
      : null;
    const stats = changeReviewFileHasLineStats(file)
      ? {
          added: changeReviewNumber(file.added),
          removed: changeReviewNumber(file.removed),
        }
      : null;
    const block = {
      name: 'ChangeReview',
      input: { file_path: filePath },
    };
    const languageClass = renderer.languageClassForPath(filePath);
    closeChangeReviewModal();
    try {
      renderer.openModal(payload, block, stats, languageClass, lineInfo);
    } catch (error) {
      openChangeReviewModalShell(title,
        changeReviewText('diffFail', { msg: error && error.message ? error.message : String(error) }));
    }
  }

  function deferredRowAfterPoint(list, y) {
    const rows = Array.from(
      list.querySelectorAll(':scope > [data-incipit-deferred-row]:not([data-incipit-deferred-dragging])'),
    );
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (y < b.top + b.height / 2) return r;
    }
    return null;
  }

  function commitDeferredOrderFromDom(list) {
    const ids = Array.from(
      list.querySelectorAll(':scope > [data-incipit-deferred-row]'),
    ).map(r => r.getAttribute('data-incipit-deferred-id'));
    deferredQueue.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    scheduleDeferredNextRender();
  }

  // Pointer-drag on the grip (NOT native HTML5 DnD — flaky in the webview,
  // and it would collide with the editor's file-drop). The in-flight or
  // editing row is locked.
  function startDeferredRowDrag(evt, item, row) {
    if (item.sending || item.editing) return;
    const list = row.parentElement;
    if (!list) return;
    evt.preventDefault();
    deferredDragId = item.id;
    row.setAttribute('data-incipit-deferred-dragging', '');
    const onMove = ev => {
      const after = deferredRowAfterPoint(list, ev.clientY);
      if (after == null) list.appendChild(row);
      else if (after !== row) list.insertBefore(row, after);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      row.removeAttribute('data-incipit-deferred-dragging');
      deferredDragId = null;
      commitDeferredOrderFromDom(list);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
  }

  function renderDeferredNextSummary(el, item) {
    const row = document.createElement('div');
    row.setAttribute('data-incipit-deferred-next-row', '');

    const grip = document.createElement('span');
    grip.setAttribute('data-incipit-deferred-next-grip', '');
    grip.title = deferredText('reorder');
    grip.textContent = '::';
    grip.addEventListener('pointerdown', evt => startDeferredRowDrag(evt, item, el));
    row.appendChild(grip);

    const text = document.createElement('div');
    text.setAttribute('data-incipit-deferred-next-text', '');
    text.textContent = item.sending ? deferredText('sending') : summarizeDeferredText(item.text, item.attachments);
    row.appendChild(text);

    const guide = document.createElement('button');
    guide.type = 'button';
    guide.setAttribute('data-incipit-deferred-next-guide', '');
    guide.title = deferredText('guideTitle');
    guide.innerHTML = '<span data-incipit-deferred-next-guide-icon>' + GUIDE_ICON_SVG + '</span>' +
      '<span data-incipit-deferred-next-guide-label>' + deferredText('guide') + '</span>';
    guide.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      guideDeferredNextNow(item);
    });
    row.appendChild(guide);

    // Flattened action row. The old kebab held only Edit + "Close
    // queue", and "Close queue" was the literal same call as the trash
    // button beside it (`discardDeferredNext(item.id)`) — a redundant
    // destructive duplicate hidden behind an extra tap. Edit + Delete
    // are now direct icons (edit before delete: constructive then
    // destructive, matching the user-bubble action order).
    row.appendChild(makeDeferredIconButton('edit', deferredText('edit'), EDIT_ICON_SVG, () => {
      startEditingDeferredNext(item.id);
    }));
    row.appendChild(makeDeferredIconButton('delete', deferredText('removeTitle'), TRASH_ICON_SVG, () => {
      discardDeferredNext(item.id);
    }));

    el.appendChild(row);
    const strip = renderDeferredAttachmentStrip(item);
    if (strip) el.appendChild(strip);
  }

  function renderDeferredNextEditor(el, item) {
    if (!item.editDraft) item.editDraft = cloneDeferredForEdit(item);
    const draft = item.editDraft;
    const row = document.createElement('div');
    row.setAttribute('data-incipit-deferred-next-edit', '');

    const textarea = document.createElement('textarea');
    textarea.setAttribute('data-incipit-deferred-next-textarea', '');
    textarea.value = draft.text;
    textarea.rows = 2;
    textarea.placeholder = deferredText('pasteDrop');
    textarea.addEventListener('input', () => { draft.text = textarea.value; });
    textarea.addEventListener('paste', evt => handleDeferredImagePaste(evt, draft));
    textarea.addEventListener('keydown', evt => {
      // Never steal a key mid CJK IME composition (229 = legacy keyCode for
      // an in-progress composition); Enter/Escape there belong to the IME.
      if (evt.isComposing || evt.keyCode === 229) return;
      if (evt.key === 'Escape') {
        evt.preventDefault();
        evt.stopPropagation();
        item.editing = false;
        item.editDraft = null;
        scheduleDeferredNextRender();
        return;
      }
      if (evt.key === 'Enter' && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        evt.stopPropagation();
        saveDeferredNextEdit(item);
      }
    });
    row.appendChild(textarea);

    const strip = renderDeferredAttachmentStrip(item, draft);
    if (strip) row.appendChild(strip);

    // Add-image now lives as the dashed '+' slot INSIDE the chip strip
    // (built in renderDeferredAttachmentStrip), mirroring the user-bubble
    // editor. The action row is just Cancel / Save — no stray button.
    const actions = document.createElement('div');
    actions.setAttribute('data-incipit-deferred-next-edit-actions', '');

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.setAttribute('data-incipit-deferred-next-edit-cancel', '');
    cancel.textContent = deferredText('cancel');
    cancel.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      item.editing = false;
      item.editDraft = null;
      scheduleDeferredNextRender();
    });
    actions.appendChild(cancel);

    const save = document.createElement('button');
    save.type = 'button';
    save.setAttribute('data-incipit-deferred-next-edit-save', '');
    save.textContent = deferredText('save');
    save.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      saveDeferredNextEdit(item);
    });
    actions.appendChild(save);

    row.appendChild(actions);
    row.addEventListener('dragover', evt => {
      if (!hasFileishDrag(evt.dataTransfer)) return;
      evt.preventDefault();
      evt.stopPropagation();
      try { evt.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    row.addEventListener('drop', evt => {
      if (!hasFileishDrag(evt.dataTransfer)) return;
      evt.preventDefault();
      evt.stopPropagation();
      for (const file of Array.from(evt.dataTransfer.files || [])) addDeferredAttachmentFromFile(draft, file);
    });

    el.appendChild(row);
    setTimeout(() => {
      try {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      } catch (_) {}
    }, 0);
  }

  function startEditingDeferredNext(id) {
    const item = deferredFindById(id);
    if (!item || item.sending) return;
    item.editing = true;
    item.editDraft = cloneDeferredForEdit(item);
    deferredInlineError = '';
    scheduleDeferredNextRender();
  }

  function saveDeferredNextEdit(item) {
    if (!item || !item.editDraft) return;
    const text = String(item.editDraft.text || '');
    const attachments = normalizeDeferredAttachments(item.editDraft.attachments);
    if (!deferredPayloadHasContent(text, attachments)) {
      setDeferredInlineError(deferredText('empty'));
      return;
    }
    item.text = text;
    item.attachments = attachments;
    item.editing = false;
    item.editDraft = null;
    deferredInlineError = '';
    // No flush here: the queue still only releases on a natural turn end.
    scheduleDeferredNextRender();
  }

  function handleDeferredImagePaste(evt, draft) {
    const items = (evt.clipboardData && evt.clipboardData.items) || [];
    let handled = false;
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type || '')) {
        const file = it.getAsFile && it.getAsFile();
        if (file) {
          addDeferredAttachmentFromFile(draft, file);
          handled = true;
        }
      }
    }
    if (handled) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  function addDeferredAttachmentFromFile(draft, file) {
    if (!draft || !file) return;
    // Shared allow-list / cap with the user-bubble inline editor — one
    // source of truth. Error sink stays INLINE (the card), never a toast:
    // the bubble path toasts, this path must not (deferred-next contract).
    if (!ALLOWED_INLINE_IMAGE_MIMES.has(file.type)) {
      setDeferredInlineError(deferredText('badType'));
      return;
    }
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      setDeferredInlineError(deferredText('tooLarge', {
        size: (file.size / 1024 / 1024).toFixed(1),
      }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!/^data:image\//i.test(dataUrl)) {
        setDeferredInlineError(deferredText('readFail'));
        return;
      }
      deferredInlineError = '';
      draft.attachments.push({ file, dataUrl });
      scheduleDeferredNextRender();
    };
    reader.onerror = () => setDeferredInlineError(deferredText('readFail'));
    reader.readAsDataURL(file);
  }

  function discardDeferredNext(id) {
    if (id == null) deferredQueue = [];
    else deferredRemoveById(id);
    if (!deferredQueue.length) { deferredInlineError = ''; removeDeferredNextCard(); }
    else scheduleDeferredNextRender();
  }

  // Manual "Guide": send THIS item now through the original host send,
  // bypassing the queue — available any time, including a frozen/interrupted
  // state. Only this item leaves; the rest stay queued in order.
  async function guideDeferredNextNow(item) {
    if (!item || item.sending) return;
    const active = locateActiveSessionState();
    if (active && !deferredSessionMatchesItem(active, item)) {
      scheduleDeferredNextRender();
      return;
    }
    const session = active || item.session;
    const rawSend = rawSendForSession(session);
    if (!session || typeof rawSend !== 'function') return;
    item.sending = true;
    scheduleDeferredNextRender();
    try {
      deferredNextBypassDepth++;
      await rawSend.apply(session, [item.text, item.attachments, false]);
      deferredRemoveById(item.id);
      if (!deferredQueue.length) removeDeferredNextCard();
      else scheduleDeferredNextRender();
    } catch (error) {
      item.sending = false;
      setDeferredInlineError(deferredText('sendFail', {
        msg: error && error.message ? error.message : String(error),
      }));
    } finally {
      deferredNextBypassDepth--;
    }
  }

  // Releases EXACTLY the head, and only when the just-ended turn looks
  // natural (re-checked here even though armNaturalEndConfirm already
  // gated — the error interrupt-marker can land between the two). It does
  // NOT chain to the next item: the next release waits for THIS new turn
  // to end naturally (a fresh armNaturalEndConfirm on the next settle).
  async function flushDeferredNextIfReady() {
    const item = deferredHead();
    if (!item || item.sending || item.editing || deferredNextFlushInFlight) return;
    if (deferredAnySending()) return;
    if (!deferredTurnLooksNatural()) { scheduleDeferredNextRender(); return; }
    const active = locateActiveSessionState();
    const activeSessionId = sessionIdOf(active);
    if (!active || !item.sessionId || activeSessionId !== item.sessionId) {
      scheduleDeferredNextRender();
      return;
    }
    if (sessionIsBusy(active)) return;  // a turn started; re-arms on next settle
    const rawSend = rawSendForSession(active);
    if (typeof rawSend !== 'function') return;
    item.sending = true;
    deferredNextFlushInFlight = true;
    scheduleDeferredNextRender();
    try {
      deferredNextBypassDepth++;
      await rawSend.apply(active, [item.text, item.attachments, false]);
      deferredRemoveById(item.id);
      if (!deferredQueue.length) removeDeferredNextCard();
      else scheduleDeferredNextRender();
    } catch (error) {
      item.sending = false;
      setDeferredInlineError(deferredText('sendFail', {
        msg: error && error.message ? error.message : String(error),
      }));
    } finally {
      deferredNextBypassDepth--;
      deferredNextFlushInFlight = false;
    }
  }

  function setupDeferredNextVisibilityObserver() {
    if (deferredNextVisibilityObserver || !document.body) return;
    deferredNextVisibilityObserver = new MutationObserver(muts => {
      if (!deferredQueue.length && !deferredNextEl) return;
      let touched = false;
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        if (mutationInsideFocusedEditor(m)) continue;
        for (const node of m.addedNodes) {
          if (deferredNodeTouchesComposerOrAsk(node)) {
            touched = true;
            break;
          }
        }
        if (touched) break;
        for (const node of m.removedNodes) {
          if (deferredNodeTouchesComposerOrAsk(node)) {
            touched = true;
            break;
          }
        }
        if (touched) break;
      }
      if (!touched) return;
      scheduleDeferredNextRender();
      if (deferredQueue.length && !askPanelIsActive() && !deferredConvBusySafe()) {
        armNaturalEndConfirm();
      }
    });
    deferredNextVisibilityObserver.observe(document.body, { childList: true, subtree: true });
  }

  function setupDeferredNextMessageQueue() {
    if (deferredNextSetupBound) return;
    deferredNextSetupBound = true;
    setupDeferredNextVisibilityObserver();
    scheduleDeferredSessionPatch(0);
    subscribeRuntime('sessionChanged', () => {
      deferredNextPatchAttempts = 0;
      scheduleDeferredSessionPatch(0);
      cancelNaturalEndConfirm();          // never carry a pending release across sessions
      scheduleDeferredNextRender();
    });
    subscribeRuntime('busyChanged', evt => {
      deferredNextPatchAttempts = 0;
      scheduleDeferredSessionPatch(0);
      // A turn went live (or a tool round-trip) → never release mid-flight.
      if (evt && evt.busy === true) cancelNaturalEndConfirm();
      scheduleDeferredNextRender();
    });
    // Both fire for natural end AND for Stop/error alike — they only ARM the
    // sustained confirm window; the window's re-check (interrupted marker /
    // partial tail) is what actually refuses an interrupted turn.
    subscribeRuntime('streamSettled', () => { armNaturalEndConfirm(); });
    subscribeRuntime('assistantTurnFinalized', () => { armNaturalEndConfirm(); });
    reportHealth('legacy.deferred_next', 'ok');
  }

  function setupChangeReviewFileReview() {
    setupChangeReviewChannel();
    scheduleChangeReviewIdentityUpdate(0);
    subscribeRuntime('sessionChanged', () => {
      changeReviewPayload = null;
      changeReviewStartedTurnKey = '';
      cancelChangeReviewTurnStarted();
      scheduleChangeReviewIdentityUpdate(0);
      if (!changeReviewBusySafe()) scheduleChangeReviewTurnBlocksRender();
    });
    subscribeRuntime('messagesChanged', () => {
      scheduleChangeReviewIdentityUpdate(250);
      if (changeReviewBusySafe()) scheduleChangeReviewTurnStarted(20);
    });
    subscribeRuntime('busyChanged', evt => {
      if (evt && evt.busy === true) armChangeReviewTurnStarted();
      else cancelChangeReviewTurnStarted();
      if (!changeReviewBusySafe()) {
        scheduleChangeReviewIdentityUpdate(250);
      } else {
        removeCurrentBusyChangeReviewTurnBlocks();
      }
    });
    subscribeRuntime('assistantTurnFinalized', () => {
      if (changeReviewBusySafe()) {
        removeCurrentBusyChangeReviewTurnBlocks();
        return;
      }
      cancelChangeReviewTurnStarted();
      notifyChangeReviewTurnFinalized();
      changeReviewStartedTurnKey = '';
      scheduleChangeReviewIdentityUpdate(150);
      setTimeout(() => {
        scheduleChangeReviewTurnBlocksRender();
      }, 220);
    });
    reportHealth('legacy.change_review', 'ok');
  }

  function setupTranscriptMutationChannel() {
    if (transcriptMutationListenerBound) return;
    transcriptMutationListenerBound = true;
    window.addEventListener('message', evt => {
      const msg = evt && evt.data;
      if (!msg || msg.__incipit !== true || msg.type !== 'conversation_mutation_response') return;
      const pending = transcriptMutationPending.get(msg.requestId);
      if (!pending) return;
      transcriptMutationPending.delete(msg.requestId);
      const payload = msg.payload || {};
      if (payload.ok === false) pending.reject(new Error(payload.error || legacyText('transcript_mutation_failed_fallback')));
      else pending.resolve(payload);
    });
  }

  function requestTranscriptMutation(op, payload, options) {
    const allowBusy = !!(options && options.allowBusy);
    if (!allowBusy) {
      // Fail-closed: this is the single choke point for every local-history
      // write (edit/delete/truncate). Unknown busy must reject, not pass.
      const busy = conversationBusyTriState();
      if (busy === true) {
        return Promise.reject(new Error(legacyText('wait_for_reply_before_history_edit')));
      }
      if (busy !== false) {
        return Promise.reject(new Error(legacyText('cannot_confirm_idle_history_blocked')));
      }
    }
    setupTranscriptMutationChannel();
    const api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') {
      return Promise.reject(new Error(legacyText('webview_channel_unreachable')));
    }
    const requestId = 'mut-' + (++transcriptMutationSeq).toString(36);
    const message = {
      __incipit: true,
      type: 'conversation_mutation_request',
      requestId,
      op,
      ...payload,
    };
    return new Promise((resolve, reject) => {
      transcriptMutationPending.set(requestId, { resolve, reject });
      try {
        api.postMessage(message);
      } catch (error) {
        transcriptMutationPending.delete(requestId);
        reject(error);
      }
      setTimeout(() => {
        const pending = transcriptMutationPending.get(requestId);
        if (!pending) return;
        transcriptMutationPending.delete(requestId);
        pending.reject(new Error(legacyText('local_history_write_timed_out')));
      }, 12000);
    });
  }

  const assistantUuidResolvePending = new Map();

  async function ensureAssistantRecordUuid(record) {
    if (!record || record.type !== 'assistant') return record;
    if (recordUuid(record)) return record;

    const live = liveTranscriptRecord(null, record);
    if (live && recordUuid(live)) return live;

    const betaMessageId = recordBetaMessageId(live || record);
    if (!betaMessageId) return live || record;

    const identity = transcriptRecordIdentity(live || record);
    if (!identity) return live || record;

    const key = `${identity.sessionId}:${betaMessageId}`;
    let pending = assistantUuidResolvePending.get(key);
    if (!pending) {
      pending = requestTranscriptMutation('resolve_assistant_uuid', {
        betaMessageId,
        textTail: transcriptText(live || record).slice(-600),
        ...identity,
      }).then(payload => {
        const uuid = payload && typeof payload.uuid === 'string' ? payload.uuid : '';
        if (uuid) {
          try { record.uuid = uuid; } catch (_) {}
          if (live && live !== record) {
            try { live.uuid = uuid; } catch (_) {}
          }
        }
        return uuid;
      }).finally(() => {
        assistantUuidResolvePending.delete(key);
      });
      assistantUuidResolvePending.set(key, pending);
    }

    try { await pending; }
    catch (_) { return live || record; }
    return liveTranscriptRecord(null, live || record) || live || record;
  }

  function nodeIsRendered(node) {
    return !!(
      node &&
      (node.offsetWidth || node.offsetHeight ||
        (node.getClientRects && node.getClientRects().length))
    );
  }

  function readSendButtonDomState() {
    const buttons = document.querySelectorAll('[data-incipit-send-button], [class*="sendButton"]');
    let sawSend = false;
    for (const button of buttons) {
      if (!nodeIsRendered(button)) continue;
      // The theme hides the host SVGs and draws replacement masks on the
      // button. Treat the icon classes as semantic state, not rendered
      // geometry; stale data attrs are only a fallback because React can
      // change sendIcon -> stopIcon by mutating class on the same svg node.
      if (button.querySelector('[class*="stopIcon"]')) return 'stop';
      if (button.querySelector('[class*="sendIcon"]')) {
        sawSend = true;
        continue;
      }
      if (button.querySelector('[data-incipit-stop-icon]')) return 'stop';
      if (button.querySelector('[data-incipit-send-icon]')) {
        sawSend = true;
        continue;
      }
      if (button.getAttribute('data-incipit-send-state') === 'stop') return 'stop';
      if (button.getAttribute('data-incipit-send-state') === 'send') sawSend = true;
    }
    return sawSend ? 'send' : null;
  }

  function sendButtonDomState() {
    const now = nowMs();
    if (sendButtonDomCachedAt && now - sendButtonDomCachedAt <= SEND_BUTTON_DOM_CACHE_MS) {
      return sendButtonDomCachedValue;
    }
    sendButtonDomCachedValue = readSendButtonDomState();
    sendButtonDomCachedAt = now;
    return sendButtonDomCachedValue;
  }

  // NOTE: a turn interrupted mid-thinking persists a degenerate
  // `thinking` block (signature present, empty text). We deliberately do
  // NOT fold that into `transcriptBlockIsPartial`: this predicate feeds
  // `activeSessionHasPartialTail()` → `conversationIsBusy()` → the whole
  // action-row / edit / fork / streaming-disable system. The interrupted
  // record stays in `messages.value` until the rerun truncates it, so
  // treating it as "partial" would wedge incipit into a permanent
  // pseudo-busy state. The interrupt→rerun safety lives in the rerun
  // hand-off serializer instead (busy-stable + interrupt cooldown +
  // post-cut JSONL-not-advanced peek), which keys off real liveness
  // signals that actually clear on their own.
  function transcriptBlockIsPartial(block) {
    if (!block || typeof block !== 'object') return false;
    if (block.partial === true) return true;
    const inner = block.content;
    return !!(inner && typeof inner === 'object' && inner.partial === true);
  }

  function transcriptRecordHasPartialContent(record) {
    const content = transcriptContent(record);
    if (!Array.isArray(content)) return false;
    return content.some(transcriptBlockIsPartial);
  }

  function activeSessionHasPartialTail() {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    let seen = 0;
    for (let i = messages.length - 1; i >= 0 && seen < 12; i--) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'assistant') {
        seen++;
        if (transcriptRecordHasPartialContent(m)) return true;
        continue;
      }
      if (m.type === 'user') {
        if (transcriptHasToolResult(m)) {
          seen++;
          continue;
        }
        break;
      }
      seen++;
    }
    return false;
  }

  function activeSessionBusyState() {
    const session = locateActiveSessionState();
    const busy = session && session.busy;
    if (busy && typeof busy === 'object' && 'value' in busy) {
      try {
        if (typeof busy.value === 'boolean') return busy.value;
      } catch (_) {}
    }
    if (typeof busy === 'boolean') return busy;
    return null;
  }

  // Tri-state: true / false / null. null means "every probe surface missed"
  // (no session fiber, no rendered send/stop button, no partial-tail signal)
  // and is NOT the same as false. Before 2026-06-09 this collapsed to false,
  // which meant one host refactor that moves the class stems AND the fiber
  // shape silently green-lit rerun/save/flush into a possibly-live stream.
  // Do not "simplify" the trailing null back to false: state-mutating
  // callers treat null as busy (fail-closed), visual callers as idle.
  function legacyCompositeBusyProbe() {
    // A bridge busy=true is authoritative. A bridge/session busy=false is not:
    // Claude Code can briefly drop it between assistant text and follow-up
    // tool calls while the footer still shows Stop and the turn is not done.
    // So false always falls through to the DOM/partial safety probes.
    const sessionBusy = activeSessionBusyState();
    if (sessionBusy === true) return true;

    const domState = sendButtonDomState();
    if (domState === 'stop') return true;
    // A visible send icon is authoritative once the message area has
    // stopped changing; while mutations are fresh, prefer the partial
    // transcript flag because it closes the send→stop transition race.
    if (domState === 'send' && nowMs() - lastTranscriptMutationAt > 1500) return false;
    if (activeSessionHasPartialTail()) return true;
    // Real fiber evidence: the SessionState was reachable and reported
    // not-busy (partial tail above was readable from the same instance).
    if (sessionBusy === false) return false;
    return null;
  }

  let runtimeBusyProbeRegistered = false;
  function setupRuntimeBusyProbe() {
    if (runtimeBusyProbeRegistered) return;
    runtimeBusyProbeRegistered = true;
    try {
      registerRuntimeBusyProbe('legacy.compositeBusy', legacyCompositeBusyProbe);
      reportHealth('legacy.runtime_busy_probe', 'ok');
    } catch (_) {
      reportHealth('legacy.runtime_busy_probe', 'degraded');
    }
  }

  // Tri-state busy resolution: true / false / null(unknown). The kernel
  // throws when no probe surface can answer; the legacy probe returns null
  // for the same condition. Both funnel here so the two predicates below
  // stay the single source of "how does unknown behave".
  function conversationBusyTriState() {
    try {
      return kernelConversationIsBusy() === true;
    }
    catch (_) { /* Kernel cannot tell — fall through to the legacy probe. */ }
    try {
      return legacyCompositeBusyProbe();
    }
    catch (_) { return null; }
  }

  // Fail-open predicate for read-only / visual surfaces (action rows,
  // disable sweeps, typography, badges): unknown counts as idle, so a
  // broken probe surface degrades to "UI stays alive", never to "every
  // feature bricks". State-mutating paths must NOT use this one.
  function conversationIsBusy() {
    return conversationBusyTriState() === true;
  }

  // Fail-closed predicate for state-mutating paths (rerun/send hand-off,
  // deferred capture/flush, JSONL mutation, fork/rewind, edit save):
  // unknown counts as busy. "All probes missed" must never green-light an
  // action that can feed a second stream into the host's root assembler
  // or rewrite the transcript under a live turn (2026-06-09).
  function conversationBusyOrUnknown() {
    return conversationBusyTriState() !== false;
  }

  // Entry gate for user-triggered mutating actions (fork/rewind/save).
  // Returns true when the action must be blocked. The buttons themselves
  // stay enabled fail-open, so when the answer is unknown we surface a
  // toast instead of silently eating the click — a broken probe surface
  // should look broken, not dead.
  function blockMutationWhileBusyOrUnknown() {
    const busy = conversationBusyTriState();
    if (busy === false) return false;
    if (busy === null) {
      showTranscriptToast(legacyText('stream_not_idle_blocked'), 'warn');
    }
    return true;
  }

  // "Is the OLD streaming process actually stopped?" — the pre-truncate
  // gate for the rerun hand-off. It checks only liveness signals that
  // clear on their own once the interrupted CLI drains:
  //   • busy  — host SessionState still streaming, or DOM stop icon
  //   • interrupt-cooldown — we issued interruptClaude too recently for
  //     the process to have torn down yet
  // It deliberately does NOT consult `activeSessionHasPartialTail()`:
  // the interrupted-thinking record we are about to truncate is *itself*
  // a "partial tail", so waiting for it to vanish here would never
  // succeed (only the truncate removes it) — that was the cause of the
  // 8s stall + bubble-vanish-then-revert regression. The post-cut peek
  // (a real foreign-write signal) covers the residual-flush case.
  function activeSessionTailUnsafeReason() {
    // Fail-closed: an unknown busy answer reads as 'busy', so the quiesce
    // loop keeps waiting and times out cleanly pre-truncate instead of
    // cutting the JSONL under a stream nobody can observe.
    if (conversationBusyOrUnknown()) return 'busy';
    if (sinceLastChannelInterrupt() < CHANNEL_INTERRUPT_COOLDOWN_MS) return 'interrupt-cooldown';
    return null;
  }

  // ---- Phase 1: quiesce the old stream BEFORE touching the JSONL ----
  //
  // Called while the user bubble is still visible and nothing has been
  // mutated yet. We actively interrupt the live channel, then wait until
  // the old streaming process is genuinely stopped (busy stable-false +
  // interrupt cooldown elapsed) so the upcoming truncate + resume does
  // not race a still-flushing stream. Because this runs pre-truncate, a
  // timeout aborts cleanly with the conversation completely untouched —
  // no vanished bubble, no rollback needed.
  //
  // Resolves { ok:true } | { ok:false, reason:'timeout' }.
  async function quiesceOldStream() {
    // Kick the old turn toward a clean stop up front.
    try {
      const s0 = locateActiveSessionState();
      const c0 = locateConnection();
      const ch0 = s0 && s0.claudeChannelId;
      if (ch0 && c0 && typeof c0.interruptClaude === 'function') {
        c0.interruptClaude(ch0);
        noteChannelInterrupt();
      }
    } catch (_) {}

    const deadline = nowMs() + TURN_HANDOFF_TIMEOUT_MS;
    let quietSince = 0;
    let reinterrupts = 0;
    while (true) {
      const unsafe = activeSessionTailUnsafeReason();
      if (!unsafe) {
        if (quietSince === 0) quietSince = nowMs();
        if (nowMs() - quietSince >= TURN_HANDOFF_QUIET_MS) return { ok: true };
      } else {
        quietSince = 0;
        if (unsafe === 'busy' && reinterrupts < 4) {
          reinterrupts++;
          try {
            const s = locateActiveSessionState();
            const c = locateConnection();
            const ch = s && s.claudeChannelId;
            if (ch && c && typeof c.interruptClaude === 'function') {
              c.interruptClaude(ch);
              noteChannelInterrupt();
            }
          } catch (_) {}
        }
      }
      if (nowMs() >= deadline) return { ok: false, reason: 'timeout' };
      await new Promise(r => setTimeout(r, TURN_HANDOFF_POLL_MS));
    }
  }

  // ---- Phase 2: confirm the cut transcript is not being appended ----
  //
  // Runs right after `truncate_from_user`. Phase 1 already proved the old
  // stream stopped, so this is a short guard against the rare race where
  // a writer (a residual CLI flush, or a host-injected task-notification
  // continuation) appended around the cut instant. The `peek` op is
  // read-only and does NOT consume the rollback token.
  //
  // Resolves:
  //   { ok:true }                       → safe to send
  //   { ok:false, reason:'advanced' }   → foreign write after the cut;
  //                                        caller MUST roll back + abort
  //   { ok:false, reason:'timeout' }    → never confirmed quiet in budget
  async function confirmCutQuiescent(opts) {
    const o = opts || {};
    const deadline = nowMs() + CUT_CONFIRM_TIMEOUT_MS;
    while (true) {
      let advanced = false;
      let checked = false;
      if (o.rollbackToken && o.identity && o.uuid) {
        try {
          const peek = await requestTranscriptMutation('peek_truncate_state', {
            uuid: o.uuid,
            rollbackToken: o.rollbackToken,
            ...o.identity,
          }, { allowBusy: true });
          if (peek && peek.hasToken === true) {
            checked = true;
            if (peek.advanced === true) advanced = true;
          }
        } catch (_) { /* transient peek failure → retry within budget */ }
      }
      if (advanced) return { ok: false, reason: 'advanced' };
      // Quiet once the cut reads un-advanced and we are not busy. If the
      // token expired (checked stays false) fall back to the busy gate
      // only — phase 1 already established the stream had stopped.
      // Fail-closed: unknown busy keeps polling until the budget runs out.
      if (!conversationBusyOrUnknown() && (checked || !o.rollbackToken ||
          sinceLastChannelInterrupt() >= CHANNEL_INTERRUPT_COOLDOWN_MS)) {
        return { ok: true };
      }
      if (nowMs() >= deadline) return { ok: false, reason: 'timeout' };
      await new Promise(r => setTimeout(r, TURN_HANDOFF_POLL_MS));
    }
  }

  function showTranscriptToast(text, kind = '') {
    let toast = document.querySelector('[data-incipit-transcript-toast]');
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('data-incipit-transcript-toast', '');
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.setAttribute('data-kind', kind);
    toast.setAttribute('data-visible', '1');
    clearTimeout(toast.__incipitTimer);
    toast.__incipitTimer = setTimeout(() => {
      toast.removeAttribute('data-visible');
    }, 2600);
  }

  // After a JSONL mutation succeeds, reflect the change in the live
  // webview state without `window.location.reload()` (which blanks
  // VS Code webviews because `acquireVsCodeApi()` can only be called
  // once per webview lifecycle) and without `loadFromServer()` (which
  // flips `isLoading.value` and renders a "Loading..." placeholder
  // mid-transition — visible flicker).
  //
  // Strategy:
  //   1. Mutate `activeSession.messages.value` directly. React keys
  //      messages by uuid, so removed rows disappear and edited rows
  //      re-render in place — siblings are untouched.
  //   2. Interrupt the live Claude CLI for this session and null out
  //      `claudeChannelId`. The CLI's in-memory transcript is now
  //      stale (it was hydrated once at spawn time and only appends
  //      thereafter — confirmed by the fact that a window reload was
  //      previously needed for edits to "stick"). Tearing it down
  //      defers the spawn cost to the user's next send().
  //   3. Next send() runs the host's standard path:
  //        await this.launchClaude()  // sees channelId === null,
  //                                    // spawns a fresh process in
  //                                    // resume mode against the
  //                                    // edited JSONL.
  //      User-visible delay is only the spawn time on the first
  //      token (~the same wait as opening a session for the first
  //      time). No flicker, no loading placeholder, no reload.
  function reflectTranscriptMutation(op, payload, newText) {
    const session = locateActiveSessionState();
    const conn = locateConnection();

    // Step 1 — mutate messages.value to reflect the change instantly.
    // Only edit ops reach here; truncate has its own reflect path
    // inside `rerunFromUser` because it also needs to trigger a fresh
    // send afterwards.
    if (session && session.messages && Array.isArray(session.messages.value)) {
      const current = session.messages.value;
      let next = null;
      if (op === 'edit_user' || op === 'edit_assistant_text') {
        const targetUuid = payload && payload.uuid;
        if (targetUuid && typeof newText === 'string') {
          const idx = transcriptRecordIndex(current, { uuid: targetUuid });
          if (idx >= 0) {
            next = current.slice();
            next[idx] = makeEditedMessage(current[idx], newText);
          }
        }
      }
      if (next) {
        try { session.messages.value = next; } catch (_) {}
      }
    }

    // Step 2 — tear down current Claude CLI; defer spawn to next send.
    if (session) {
      const oldChannelId = session.claudeChannelId;
      if (oldChannelId && conn && typeof conn.interruptClaude === 'function') {
        try { conn.interruptClaude(oldChannelId); } catch (_) {}
        noteChannelInterrupt();
      }
      try { session.claudeChannelId = null; } catch (_) {}
      // Also clear loadingPromise so a future loadFromServer (e.g. on
      // session resume) actually re-runs against the new JSONL.
      try { session.loadingPromise = undefined; } catch (_) {}
    }

    // Step 3 — only surface a toast when we couldn't locate the
    // SessionState (rare React-shape drift). In the success path the
    // user can see the change directly in the bubble list, so a
    // confirmation toast is just noise that overlaps the input.
    if (!session) {
      showTranscriptToast(legacyText('local_history_updated_refresh'), 'warn');
    }
  }

  // Block-aware reflect for rich user edits. Replaces the target Ez
  // with a block-rebuilt Ez (kept SYs preserved by reference, new
  // text/image SYs minted) and tears down the live channel. Mirrors
  // the channel-teardown half of reflectTranscriptMutation; the only
  // structural difference is which Ez constructor is used.
  function reflectUserEditBlocks(uuid, blocksSpec) {
    const session = locateActiveSessionState();
    const conn = locateConnection();
    if (session && session.messages && Array.isArray(session.messages.value)) {
      const cur = session.messages.value;
      const idx = transcriptRecordIndex(cur, { uuid });
      if (idx >= 0) {
        const newEz = makeEditedMessageBlocks(cur[idx], blocksSpec);
        if (newEz && newEz !== cur[idx]) {
          const next = cur.slice();
          next[idx] = newEz;
          try { session.messages.value = next; } catch (_) {}
        }
      }
    }
    if (session) {
      const oldChannelId = session.claudeChannelId;
      if (oldChannelId && conn && typeof conn.interruptClaude === 'function') {
        try { conn.interruptClaude(oldChannelId); } catch (_) {}
        noteChannelInterrupt();
      }
      try { session.claudeChannelId = null; } catch (_) {}
      try { session.loadingPromise = undefined; } catch (_) {}
    }
    if (!session) {
      showTranscriptToast(legacyText('local_history_updated_refresh'), 'warn');
    }
  }

  // ---- Rerun this turn ----
  //
  // Anchored to a user bubble. Drops the user record + everything
  // following it (assistant replies, tool calls, tool results) from
  // both the JSONL and the live SessionState, then re-sends the user's
  // text as a fresh input so Claude regenerates the turn.
  //
  // Why anchor on user bubbles: the truncation boundary is inherently
  // safe — anything left in JSONL ends at a user-or-earlier boundary,
  // so messages always start on a user role and never leave orphan
  // tool_use blocks that would violate Anthropic's API contract.
  //
  // Implementation outline:
  //   1. Send `truncate_from_user` to the host. Host walks rows by
  //      index, drops everything from this user's *latest* row onward
  //      (correctly handles compact-duplicated uuids — the row we
  //      cut at is the live one), and returns a short-lived rollback
  //      token for the exact truncated JSONL text.
  //   2. Reflect: filter messages.value down to entries before this
  //      user's index. React keys by uuid so siblings stay mounted.
  //   3. Tear down the live Claude CLI channel — same as edit reflect.
  //      Next launch is in `--resume` mode against the truncated JSONL.
  //   4. Replay the user's text through the host's own send pipeline
  //      via `session.send`. If send fails before any new JSONL append
  //      is observed, ask the host to roll the exact truncated text
  //      back to the original transcript.
  async function rerunFromUser(record, button, overridePayload = null) {
    if (!record || record.type !== 'user') return;
    // Always read current Ez from messages.value — caller's closure
    // (a button click handler bound at decoration time) holds the
    // pre-edit instance after a save replaced it. Rerun must use the
    // post-edit content (text *and* image chips), otherwise saving an
    // edit then clicking rerun replays pre-edit content and the bubble
    // appears to revert.
    record = liveTranscriptRecord(record.uuid, record);
    if (record.isSynthetic || transcriptHasToolResult(record)) return;
    // Serialize: never let a second edit/rerun handoff overlap one that
    // is still tearing down + resending — overlapping handoffs are
    // exactly how two live streams get created. We deliberately do NOT
    // early-return on `conversationIsBusy()` anymore: a turn the user
    // just interrupted reports busy=false while still draining, and
    // refusing here is also not what the user wants. The old turn is
    // actively quiesced after the truncate instead.
    if (historyHandoffInFlight) {
      showTranscriptToast(legacyText('rerun_in_progress'), 'warn');
      return;
    }

    // Build the rerun payload from the saved record's blocks. Routes
    // through the host's own send pipeline (`session.send` →
    // `zB1` → API content[]), so the model sees byte-equivalent content
    // to what the bubble shows: text, image base64 blocks, and a
    // single optional `<ide_*>` ref synthesized from the saved selection.
    const { prose, attachments, savedIdeRef } = overridePayload || buildRerunPayloadFromRecord(record);
    if (!prose && !attachments.length) {
      showTranscriptToast(legacyText('no_content_to_rerun'), 'error');
      return;
    }

    // Preflight: prove we can replay BEFORE we mutate the JSONL.
    // truncate_from_user is irreversible from the user's POV — if we
    // discover the host React shape drifted (no SessionState, no
    // session.send, no writable selection signal) only after the
    // truncate, the conversation tail is already gone and the user
    // is left with no replacement message. Resolve everything we
    // need first; only then ask the host to truncate.
    //
    // Identity must also be resolved at click time: the closure-captured
    // `identity` from button decoration is a stale snapshot that can
    // mismatch the current active session in multi-window setups.
    const liveIdentity = transcriptRecordIdentity(record);
    if (!liveIdentity) {
      showTranscriptToast(legacyText('rerun_internal_no_session'), 'error');
      return;
    }
    const session = locateActiveSessionState();
    const conn = locateConnection();
    if (!session || typeof session.send !== 'function') {
      showTranscriptToast(legacyText('rerun_internal_no_send'), 'error');
      return;
    }
    const includeSelection = !!savedIdeRef;
    const selectionWritable = !!(
      session.selection &&
      typeof session.selection === 'object' &&
      'value' in session.selection
    );
    if (includeSelection && !selectionWritable) {
      showTranscriptToast(legacyText('rerun_internal_no_selection'), 'error');
      return;
    }

    // Inflight visual on the rerun button so the click is acknowledged
    // before IPC + the React unmount cascade. Without this the click
    // produces no visible feedback for ~5–30ms (IPC) + ~200–500ms
    // (slice + mass unmount of the user bubble + every following
    // assistant/tool message + its diff islands and fold animations).
    if (button) button.dataset.incipitInflight = '1';
    // Latch the critical section: held from here until the fresh send is
    // dispatched (or aborted/rolled back). While set, a second rerun is
    // refused and every action row is greyed via `[data-incipit-handoff]`
    // so the buttons read as unavailable instead of looking live.
    setHandoffLatch(true);

    // Phase 1 — quiesce the old stream BEFORE mutating anything. The
    // bubble is still on screen; if the just-interrupted reply does not
    // stop in the budget we abort with the conversation completely
    // untouched (no vanished bubble, no rollback). This is the fix for
    // the "click rerun → bubble disappears → 8s nothing → reverts"
    // regression: we no longer cut the JSONL before the old turn is
    // confirmed stopped.
    const q1 = await quiesceOldStream();
    if (!q1.ok) {
      setHandoffLatch(false);
      if (button) button.removeAttribute('data-incipit-inflight');
      showTranscriptToast(legacyText('rerun_previous_not_stopped'), 'error');
      return;
    }

    let payload;
    try {
      payload = await requestTranscriptMutation('truncate_from_user', {
        uuid: record.uuid,
        ...liveIdentity,
      });
    } catch (error) {
      setHandoffLatch(false);
      if (button) button.removeAttribute('data-incipit-inflight');
      showTranscriptToast(error && error.message ? error.message : String(error), 'error');
      return;
    }
    if (!payload || payload.ok === false) {
      setHandoffLatch(false);
      if (button) button.removeAttribute('data-incipit-inflight');
      showTranscriptToast((payload && payload.error) || legacyText('rerun_failed_fallback'), 'error');
      return;
    }

    // Yield to the event loop so the browser paints the inflight state
    // before the slice triggers React's synchronous mass unmount of
    // the user bubble + every following message. Same total work, but
    // the click feels acknowledged instead of frozen.
    await new Promise(resolve => setTimeout(resolve, 0));

    // Slice: drop this user + everything after. session.send will push
    // the new (re-)user record; the host's launchClaude (called from
    // inside session.send) then resumes the freshly-truncated JSONL.
    let preRerunMessages = null;
    if (session.messages && Array.isArray(session.messages.value)) {
      const cur = session.messages.value;
      const idx = transcriptRecordIndex(cur, record);
      if (idx >= 0) {
        preRerunMessages = cur;
        try { session.messages.value = cur.slice(0, idx); } catch (_) {}
      }
    }
    // Force the host's launchClaude inside session.send to spawn a
    // fresh CLI process. With claudeChannelId still set, launchClaude
    // is a no-op return — the OLD CLI would receive the new sendInput,
    // which has stale in-memory message state from before our truncate.
    {
      const oldChannelId = session.claudeChannelId;
      if (oldChannelId && conn && typeof conn.interruptClaude === 'function') {
        try { conn.interruptClaude(oldChannelId); } catch (_) {}
        noteChannelInterrupt();
      }
      try { session.claudeChannelId = null; } catch (_) {}
      try { session.loadingPromise = undefined; } catch (_) {}
    }

    // ---- Phase 2: confirm the cut is not being appended ----
    //
    // Phase 1 already proved the old stream stopped. This is the short
    // guard against a writer (residual CLI flush, or a host-injected
    // task-notification continuation) appending around the cut instant.
    // If it did, fail safe: roll the cut back, restore the live message
    // list, and never start a second concurrent stream.
    const confirmed = await confirmCutQuiescent({
      rollbackToken: payload && payload.rollbackToken,
      identity: liveIdentity,
      uuid: record.uuid,
    });
    if (!confirmed.ok) {
      let rolled = null;
      if (payload && payload.rollbackToken) {
        try {
          rolled = await requestTranscriptMutation('rollback_truncate_from_user', {
            uuid: record.uuid,
            rollbackToken: payload.rollbackToken,
            ...liveIdentity,
          }, { allowBusy: true });
        } catch (_) {}
      }
      if (rolled && rolled.rolledBack && preRerunMessages &&
          session.messages && Array.isArray(session.messages.value)) {
        try { session.messages.value = preRerunMessages; } catch (_) {}
      }
      setHandoffLatch(false);
      if (button) button.removeAttribute('data-incipit-inflight');
      const why = confirmed.reason === 'advanced'
        ? legacyText('rerun_held_back_advanced')
        : legacyText('rerun_held_back_not_stopped');
      showTranscriptToast(legacyText('rerun_held_back_wrap', { why }), 'error');
      return;
    }

    // Pre-poke `session.selection.value` to the saved IDE ref so
    // `zB1` rebuilds the same `<ide_*>` text. Restore afterward so the
    // host UI's "current selection" indicator returns to live IDE
    // state. `lastSentSelection` is also cleared because session.send
    // skips the selection block when it equals the last-sent value.
    // Preflight already verified `session.selection` is writable when
    // includeSelection is true, so the writes here are unconditional.
    let didPoke = false;
    let originalSelectionValue = null;
    let originalLastSentSelection = null;
    if (includeSelection) {
      try {
        originalSelectionValue = session.selection.value;
        originalLastSentSelection = session.lastSentSelection;
        session.selection.value = savedIdeRef;
        session.lastSentSelection = null;
        didPoke = true;
      } catch (_) {}
    }

    try {
      await session.send(prose, attachments, includeSelection);
    } catch (error) {
      let rollback = null;
      let rollbackError = null;
      if (payload && payload.rollbackToken) {
        try {
          rollback = await requestTranscriptMutation('rollback_truncate_from_user', {
            uuid: record.uuid,
            rollbackToken: payload.rollbackToken,
            ...liveIdentity,
          }, { allowBusy: true });
        } catch (err) {
          rollbackError = err;
        }
      }
      const message = error && error.message ? error.message : String(error);
      if (rollback && rollback.rolledBack) {
        if (preRerunMessages && session.messages && Array.isArray(session.messages.value)) {
          try { session.messages.value = preRerunMessages; } catch (_) {}
        }
        showTranscriptToast(legacyText('rerun_send_failed_restored', { msg: message }), 'error');
      } else if (rollback && rollback.reason === 'transcript_advanced') {
        showTranscriptToast(legacyText('rerun_send_failed_after_append', { msg: message }), 'error');
      } else if (rollbackError) {
        const rollbackMessage = rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError);
        showTranscriptToast(legacyText('rerun_send_failed_rollback_failed', { msg: rollbackMessage }), 'error');
      } else {
        showTranscriptToast(legacyText('rerun_send_failed', { msg: message }), 'error');
      }
    } finally {
      if (didPoke) {
        try {
          session.selection.value = originalSelectionValue;
          session.lastSentSelection = originalLastSentSelection;
        } catch (_) {}
      }
      setHandoffLatch(false);
      if (button) button.removeAttribute('data-incipit-inflight');
    }
  }

  // ---- Fork / Rewind dispatchers ----
  //
  // Five user-bubble actions all funnel through these helpers. The
  // hard rule: every "rewind" or "fork" code path goes through the
  // host's own SessionState / AppContext methods. We never roll our
  // own file-checkpoint logic and never allocate a session ourselves.
  //
  //   • Fork (no rewind)   → context.forkConversation(sessionId, prose, prevUuid)
  //   • Rewind only        → session.rewindCode(uuid)
  //   • Rerun + rewind     → session.rewindCode(uuid)  → existing rerunFromUser
  //   • Fork + rewind      → session.rewindCode(uuid)  → forkFromUser
  //
  // Preflight is fail-closed: if the host React shape drifted and we
  // can't reach forkConversation / rewindCode, we toast and bail
  // BEFORE any irreversible call. Rewind in particular touches disk —
  // a half-applied rewind with a failing follow-up would leave the
  // user with a foreign file state and an intact transcript.

  // Walk messages.value backward from `record` looking for the
  // nearest previous assistant/user message uuid. Mirrors the host
  // Oo1 component's loop exactly (line ~2037 of webview/index.js
  // 2.1.120). Returns null when `record` is the first user message
  // — fork from there is undefined (host falls back to
  // onCreateNewSession; we don't have that callback, so we simply
  // refuse).
  function findPrevUuidForFork(record) {
    const session = locateActiveSessionState();
    if (!session || !session.messages || !Array.isArray(session.messages.value)) {
      return null;
    }
    const arr = session.messages.value;
    const idx = transcriptRecordIndex(arr, record);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      const m = arr[i];
      if (m && typeof m.uuid === 'string' && m.uuid &&
          (m.type === 'assistant' || m.type === 'user')) {
        return m.uuid;
      }
    }
    return null;
  }

  // Run host-side file rewind. Returns true iff the host confirms
  // canRewind and the meta-message was inserted by the host. On any
  // failure path we toast with a clear message and return false; the
  // caller MUST bail before taking any follow-up action (rerun /
  // fork). This keeps the disk + transcript invariant: if we couldn't
  // rewind, nothing else changes.
  async function performRewindCode(record) {
    if (!record || typeof record.uuid !== 'string' || !record.uuid) {
      showTranscriptToast(legacyText('rewind_no_checkpoint'), 'error');
      return false;
    }
    const session = locateActiveSessionState();
    if (!session || typeof session.rewindCode !== 'function') {
      showTranscriptToast(legacyText('rewind_internal_no_rewindcode'), 'error');
      return false;
    }
    let result;
    try {
      result = await session.rewindCode(record.uuid);
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      showTranscriptToast(legacyText('rewind_failed_msg', { msg }), 'error');
      return false;
    }
    if (!result || result.canRewind === false) {
      showTranscriptToast(legacyText('rewind_failed'), 'error');
      return false;
    }
    return true;
  }

  // Pure fork: clones session at `prevUuid`, seeds the new fork with
  // this user's prose. Original session is untouched. Host owns
  // openNewInTab / viewSession routing — we don't navigate.
  async function forkFromUser(record, button) {
    if (!record || record.type !== 'user') return;
    record = liveTranscriptRecord(record.uuid, record);
    if (record.isSynthetic || transcriptHasToolResult(record)) return;
    if (isCompactSummaryRecord(record)) return;
    if (blockMutationWhileBusyOrUnknown()) return;

    const session = locateActiveSessionState();
    const ctx = locateActiveAppContext();
    if (!ctx || typeof ctx.forkConversation !== 'function') {
      showTranscriptToast(legacyText('fork_internal_no_forkconversation'), 'error');
      return;
    }
    const sessionId = session && session.sessionId && session.sessionId.value;
    if (!sessionId || typeof sessionId !== 'string') {
      showTranscriptToast(legacyText('fork_internal_no_session'), 'error');
      return;
    }
    const prevUuid = findPrevUuidForFork(record);
    if (!prevUuid) {
      showTranscriptToast(legacyText('cannot_fork_first_message'), 'error');
      return;
    }
    const { prose } = buildRerunPayloadFromRecord(record);
    if (!prose) {
      showTranscriptToast(legacyText('fork_no_text_content'), 'error');
      return;
    }

    if (button) button.dataset.incipitInflight = '1';
    try {
      await ctx.forkConversation(sessionId, prose, prevUuid);
    } catch (error) {
      showTranscriptToast(
        legacyText('fork_failed', { msg: error && error.message ? error.message : String(error) }),
        'error',
      );
    } finally {
      if (button) button.removeAttribute('data-incipit-inflight');
    }
  }

  async function rewindOnlyFromUser(record, button) {
    if (!record || record.type !== 'user') return;
    record = liveTranscriptRecord(record.uuid, record);
    if (isCompactSummaryRecord(record)) return;
    if (blockMutationWhileBusyOrUnknown()) return;
    if (button) button.dataset.incipitInflight = '1';
    try { await performRewindCode(record); }
    finally { if (button) button.removeAttribute('data-incipit-inflight'); }
  }

  async function rerunWithRewindFromUser(record, button) {
    if (!record || record.type !== 'user') return;
    record = liveTranscriptRecord(record.uuid, record);
    if (record.isSynthetic || transcriptHasToolResult(record)) return;
    if (isCompactSummaryRecord(record)) return;
    if (blockMutationWhileBusyOrUnknown()) return;
    if (button) button.dataset.incipitInflight = '1';
    let rewound = false;
    try {
      rewound = await performRewindCode(record);
    } finally {
      if (!rewound && button) button.removeAttribute('data-incipit-inflight');
    }
    if (!rewound) return;
    // rerunFromUser owns its own preflight + truncate + send + the
    // inflight attr cleanup. We hand the same button forward; if rerun
    // bails on its own preflight, it removes the inflight attr.
    await rerunFromUser(record, button);
  }

  async function forkWithRewindFromUser(record, button) {
    if (!record || record.type !== 'user') return;
    record = liveTranscriptRecord(record.uuid, record);
    if (record.isSynthetic || transcriptHasToolResult(record)) return;
    if (isCompactSummaryRecord(record)) return;
    if (blockMutationWhileBusyOrUnknown()) return;
    if (button) button.dataset.incipitInflight = '1';
    let rewound = false;
    try {
      rewound = await performRewindCode(record);
    } finally {
      if (!rewound && button) button.removeAttribute('data-incipit-inflight');
    }
    if (!rewound) return;
    await forkFromUser(record, button);
  }

  // ---- inline editor (replaces modal for edit_user / edit_assistant_text) ----
  //
  // Flow:
  //   1. Mark the bubble's content node + the existing icon row with
  //      `data-incipit-inline-edit-hidden` (CSS display:none !important).
  //      We never delete host DOM — reconcile keeps thinking the icon row
  //      is mounted, so it won't try to recreate it.
  //   2. Inject a `[data-incipit-inline-edit-shell]` sibling holding a
  //      transparent <textarea> (no border, body font, terra-red caret).
  //   3. Inject an `[data-incipit-inline-edit-actions]` sibling next to
  //      the original icon row, holding [取消] [保存] text buttons.
  //   4. Save button respects `conversationIsBusy()`; sweep flips it.
  //   5. Cancel / save / Esc / Ctrl-Enter all teardown — remove the
  //      injected nodes and unhide the originals. Save also fires the
  //      transcript mutation; reflect re-renders the bubble naturally.

  const inlineEditByUuid = new Map();

  function teardownInlineEditor(uuid) {
    const state = inlineEditByUuid.get(uuid);
    if (!state) return null;
    inlineEditByUuid.delete(uuid);
    // If the user opened an image preview from this editor's chip
    // strip and then dismissed the editor (Esc / cancel / save) without
    // first closing the preview, the overlay would otherwise linger as
    // an orphan modal blocking the chat. Cheap to always call — no-op
    // when no preview is open.
    closeImagePreview();
    if (state.shellEl && state.shellEl.parentElement) state.shellEl.remove();
    if (state.editActionsEl && state.editActionsEl.parentElement) state.editActionsEl.remove();
    if (state.contentEl) state.contentEl.removeAttribute('data-incipit-inline-edit-hidden');
    if (state.originalActionRow) state.originalActionRow.removeAttribute('data-incipit-inline-edit-hidden');
    // Re-show any host attachment pill rows we hid on entering edit. The
    // host's user-bubble renders attachments either inside the bubble
    // (short messages) or as a sibling above it (long messages); both
    // carry [data-incipit-user-attachments]. Keeping the host node
    // mounted (just CSS-hidden) lets the host's React render keep
    // thinking it owns the bubble layout.
    if (state.attachmentsEl) {
      state.attachmentsEl.removeAttribute('data-incipit-inline-edit-hidden');
    }
    if (state.bubbleHost) state.bubbleHost.removeAttribute('data-incipit-inline-editing');
    return state;
  }

  function cancelInlineEditor(uuid) {
    teardownInlineEditor(uuid);
  }

  // ----- Chip strip helpers (user kind only) -----
  //
  // The chip strip lives above the textarea inside the user-bubble
  // edit shell. Each chip represents a *kept* non-prose block
  // (ide_opened_file ref, ide_selection ref, image attachment) or a
  // *new* image the user paste/drops/file-picks during the edit.
  // X removes a chip from the kept list; '+' opens a file picker for
  // adding a new image.
  //
  // State lives on the inline-editor entry: state.chips is an array
  // of chip descriptors mutated in place; renderChipStrip clears and
  // re-renders the DOM each time. With at most a handful of chips per
  // bubble, full re-render is simpler than diff-patching and produces
  // no flicker (the whole strip is below the textarea anyway).

  // 5 MB raw image cap. Anthropic accepts up to ~5MB per image; base64
  // expands ~33% in transit but the source-side cap is the right gate.
  const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
  const ALLOWED_INLINE_IMAGE_MIMES = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  ]);

  function renderInlineEditChipStrip(state) {
    const container = state && state.chipsContainerEl;
    if (!container) return;
    container.replaceChildren();
    for (const chip of state.chips) {
      container.appendChild(buildChipElement(state, chip));
    }
    if (state.chipsAddBtn) container.appendChild(state.chipsAddBtn);
    container.style.display = (state.chips.length || state.chipsAddBtn) ? '' : 'none';
  }

  function buildChipElement(state, chip) {
    const el = document.createElement('span');
    el.className = 'incipit-edit-chip';
    el.setAttribute('data-incipit-edit-chip-kind', chip.blockKind);
    el.setAttribute('data-chip-id', chip.chipId);

    if (chip.blockKind === 'image') {
      el.classList.add('incipit-edit-chip--image');
      if (chip.dataUrl) {
        const img = document.createElement('img');
        img.className = 'incipit-edit-chip-thumb';
        img.src = chip.dataUrl;
        img.alt = '';
        img.draggable = false;
        el.appendChild(img);
        // Click-to-preview. Mirrors host composer's pill click behaviour
        // (cf. host bundle H40 component): clicking the chip body opens
        // a fullscreen overlay with the image at natural-fit size, Esc
        // or backdrop-click closes. The X button has its own handler
        // that already stopPropagation's, so a click on X never reaches
        // here; we still defensive-check `closest('.incipit-edit-chip-x')`
        // for keyboard activation paths.
        el.style.cursor = 'zoom-in';
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', legacyText('preview_image'));
        el.title = legacyText('click_to_preview');
        el.addEventListener('click', (ev) => {
          if (ev.target && ev.target.closest && ev.target.closest('.incipit-edit-chip-x')) return;
          ev.preventDefault();
          ev.stopPropagation();
          openImagePreview(chip.dataUrl);
        });
        el.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          if (ev.target && ev.target.closest && ev.target.closest('.incipit-edit-chip-x')) return;
          ev.preventDefault();
          ev.stopPropagation();
          openImagePreview(chip.dataUrl);
        });
      } else {
        // Defensive: image block without a usable data URL (rare, e.g.
        // url-source images we don't render). Fall back to a neutral
        // label so the user still sees "an image is attached" and can
        // remove it.
        const label = document.createElement('span');
        label.className = 'incipit-edit-chip-label';
        label.textContent = chip.mediaType || legacyText('image_fallback_label');
        el.appendChild(label);
      }
    } else {
      // ide_opened_file / ide_selection / future ide_* fallback.
      const icon = document.createElement('span');
      icon.className = 'incipit-edit-chip-icon';
      icon.innerHTML = CHIP_FILE_ICON_SVG;
      el.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'incipit-edit-chip-label';
      label.textContent = chip.label || '';
      el.appendChild(label);
      if (chip.subLabel) {
        const sub = document.createElement('span');
        sub.className = 'incipit-edit-chip-sub';
        sub.textContent = chip.subLabel;
        el.appendChild(sub);
      }
      el.title = describeChipForTooltip(chip);
    }

    const x = document.createElement('button');
    x.className = 'incipit-edit-chip-x';
    x.type = 'button';
    x.setAttribute('aria-label', legacyText('remove_attachment'));
    x.innerHTML = CHIP_X_ICON_SVG;
    x.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      removeInlineEditChip(state, chip.chipId);
    });
    el.appendChild(x);
    return el;
  }

  function describeChipForTooltip(chip) {
    if (chip.blockKind === 'ide_opened_file') return legacyText('ide_auto_attached_file');
    if (chip.blockKind === 'ide_selection') return legacyText('ide_auto_attached_selection');
    return legacyText('attached_reference');
  }

  // Fullscreen image preview overlay. Body-portal modal — sits above
  // every other layer including dropdowns. Closes on Esc / backdrop
  // click / close-button click. Single-instance: opening a new preview
  // closes the previous one. Mirrors the behaviour of the host
  // composer's pill click (cf. host bundle H40 component) so editing a
  // user record feels visually consistent with composing a new one.
  let activeImagePreview = null;
  function openImagePreview(src) {
    if (!src) return;
    closeImagePreview();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-incipit-image-preview', '');
    overlay.tabIndex = -1;

    const img = document.createElement('img');
    img.setAttribute('data-incipit-image-preview-img', '');
    img.src = src;
    img.alt = '';
    img.draggable = false;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('data-incipit-image-preview-close', '');
    closeBtn.setAttribute('aria-label', legacyText('close_preview'));
    closeBtn.innerHTML = CHIP_X_ICON_SVG;

    overlay.appendChild(img);
    overlay.appendChild(closeBtn);

    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeImagePreview();
    }
    overlay.addEventListener('click', (e) => {
      // Only backdrop clicks close; clicks on the image or close button
      // are handled separately. The image gets `cursor:default` via CSS
      // so it doesn't read as clickable; the backdrop reads as
      // `zoom-out` to invite the close gesture.
      if (e.target === overlay) closeImagePreview();
    });
    img.addEventListener('click', (e) => { e.stopPropagation(); });
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeImagePreview();
    });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    setTimeout(() => { try { overlay.focus(); } catch (_) {} }, 0);

    activeImagePreview = {
      overlay,
      teardown: () => {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentElement) overlay.remove();
      },
    };
  }

  function closeImagePreview() {
    if (!activeImagePreview) return;
    try { activeImagePreview.teardown(); } catch (_) {}
    activeImagePreview = null;
  }

  function removeInlineEditChip(state, chipId) {
    if (!state || !chipId) return;
    const idx = state.chips.findIndex(c => c.chipId === chipId);
    if (idx < 0) return;
    state.chips.splice(idx, 1);
    renderInlineEditChipStrip(state);
  }

  // Add a brand-new image (paste/drop/file-pick) to the chip strip.
  // Async because FileReader is async. Validates MIME + size first;
  // toasts on rejection rather than failing silently.
  function addInlineEditImageFromFile(state, file) {
    if (!state || !file) return;
    if (!ALLOWED_INLINE_IMAGE_MIMES.has(file.type)) {
      showTranscriptToast(
        legacyText('attach_bad_type_detail', { type: file.type || 'unknown' }),
        'error',
      );
      return;
    }
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      showTranscriptToast(
        legacyText('attach_too_large_detail', { size: (file.size / 1024 / 1024).toFixed(1) }),
        'error',
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      // dataUrl format: "data:image/png;base64,<b64>"
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        showTranscriptToast(legacyText('image_encode_failed'), 'error');
        return;
      }
      const mediaType = m[1];
      const base64 = m[2];
      state.chipsCounter = (state.chipsCounter || 0) + 1;
      state.chips.push({
        chipId: 'n-' + state.chipsCounter,
        kind: 'image-new',
        blockKind: 'image',
        mediaType,
        dataUrl,
        source: { type: 'base64', media_type: mediaType, data: base64 },
      });
      renderInlineEditChipStrip(state);
    };
    reader.onerror = () => {
      showTranscriptToast(legacyText('image_read_failed'), 'error');
    };
    reader.readAsDataURL(file);
  }

  // Save button busy state — parallel to applyButtonBusyState. The
  // save button uses the same `data-incipit-disabled` convention so
  // makeTranscriptActionButton's click handler swallows the click
  // automatically, and CSS dims it. Title flips between live and
  // streaming-explainer text.
  function applyInlineSaveBusyState(saveBtn, busy) {
    if (!saveBtn) return;
    const want = !!busy;
    const cur = saveBtn.dataset.incipitDisabled === '1';
    if (want === cur) return;
    if (want) {
      saveBtn.dataset.incipitDisabled = '1';
      saveBtn.setAttribute('aria-disabled', 'true');
      saveBtn.setAttribute('title', legacyText('wait_for_reply_before_saving'));
    } else {
      delete saveBtn.dataset.incipitDisabled;
      saveBtn.removeAttribute('aria-disabled');
      if (saveBtn._incipitLiveTitle) {
        saveBtn.setAttribute('title', saveBtn._incipitLiveTitle);
      } else {
        saveBtn.removeAttribute('title');
      }
    }
  }

  function buildUserEditBlocksSpec(state, text) {
    const blocksSpec = [];
    for (const chip of (state.chips || [])) {
      if (chip.kind === 'keep' && Number.isInteger(chip.index)) {
        blocksSpec.push({ kind: 'keep', index: chip.index });
      } else if (chip.kind === 'image-new' && chip.source) {
        blocksSpec.push({ kind: 'image', source: chip.source });
      }
    }
    if (typeof text === 'string' && text.length > 0) {
      blocksSpec.push({ kind: 'text', text });
    }
    return blocksSpec;
  }

  async function saveAndRerunInlineEditor(uuid, button) {
    const state = inlineEditByUuid.get(uuid);
    if (!state) return;
    if (state.kind !== 'user') {
      await saveInlineEditor(uuid);
      return;
    }
    if (blockMutationWhileBusyOrUnknown()) return;
    const text = state.textarea.value;
    const blocksSpec = buildUserEditBlocksSpec(state, text);
    const rerunPayload = buildRerunPayloadFromEditorDraft(state.record, text, state.chips);
    if (blocksSpec.length === 0 || (!rerunPayload.prose && !rerunPayload.attachments.length)) {
      showTranscriptToast(legacyText('nothing_to_rerun_hint'), 'error');
      return;
    }

    // Do not persist the edited user row before cutting the old tail:
    // signed thinking blocks downstream would make that transient JSONL
    // invalid for the next host resume.
    if (button) button.dataset.incipitInflight = '1';
    if (state.saveBtn) state.saveBtn.dataset.incipitInflight = '1';
    if (state.cancelBtn) state.cancelBtn.dataset.incipitInflight = '1';
    teardownInlineEditor(uuid);
    await new Promise(resolve => setTimeout(resolve, 0));
    const live = liveTranscriptRecord(uuid, state.record);
    await rerunFromUser(live, button || state.saveRerunBtn || state.saveBtn, rerunPayload);
  }

  async function saveInlineEditor(uuid) {
    const state = inlineEditByUuid.get(uuid);
    if (!state) return;
    if (blockMutationWhileBusyOrUnknown()) return;
    const text = state.textarea.value;
    const op = state.kind === 'assistant' ? 'edit_assistant_text' : 'edit_user';

    // Build blocks payload for user kind. We always go through the
    // rich (blocks) path for user edits, never the legacy text-only
    // path: the host's text-only path uses `replaceTextContent`, which
    // walks the content array and overwrites the FIRST text block with
    // the new prose. For multi-block records (ide_opened_file +
    // user-prose, ide_selection + user-prose, image + user-prose) the
    // first text block is the ide_* wrapper, so a text-only save would
    // silently overwrite the ref while dropping the user's actual
    // prose block. Blocks path eliminates this whole class of hazard
    // by sending an explicit kept-by-index spec.
    let blocksSpec = null;
    if (state.kind === 'user') {
      blocksSpec = buildUserEditBlocksSpec(state, text);
      if (blocksSpec.length === 0) {
        showTranscriptToast(legacyText('nothing_to_save_hint'), 'error');
        return;
      }
    }

    state.saveBtn.dataset.incipitInflight = '1';
    state.cancelBtn.dataset.incipitInflight = '1';
    let payload;
    try {
      const liveIdentity = transcriptRecordIdentity(liveTranscriptRecord(uuid, state.record)) || state.identity || {};
      const requestPayload = blocksSpec
        ? { uuid, blocks: blocksSpec, ...liveIdentity }
        : { uuid, text, ...liveIdentity };
      payload = await requestTranscriptMutation(op, requestPayload);
    } catch (error) {
      if (state.saveBtn) state.saveBtn.removeAttribute('data-incipit-inflight');
      if (state.cancelBtn) state.cancelBtn.removeAttribute('data-incipit-inflight');
      showTranscriptToast(error && error.message ? error.message : String(error), 'error');
      return;
    }
    // Teardown BEFORE reflect — otherwise React's mount of the new
    // markdown root lands AFTER our hidden icon row + injected nodes,
    // leaving the icon row stranded at the top of the bubble after
    // teardown. Restoring DOM to the pre-edit shape first lets React
    // reconcile in the same position the original markdown root held.
    teardownInlineEditor(uuid);
    // Yield to the event loop so the browser can paint the closed
    // editor before reflect's synchronous React re-render of the edited
    // markdown row stalls the main thread (re-parsing markdown, hljs,
    // KaTeX). Without this, teardown + the React commit run in one
    // task and the user perceives "click → frozen → done" with zero
    // intermediate feedback. Same total work, much better responsiveness.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (blocksSpec) {
      reflectUserEditBlocks(uuid, blocksSpec);
    } else {
      reflectTranscriptMutation(op, payload, text);
    }
  }

  function openInlineEditor({ kind, record, bubbleHost, contentEl, originalActionRow, identity, initialText }) {
    if (!record || !bubbleHost || !contentEl) return;
    if (conversationIsBusy()) return;
    const existing = inlineEditByUuid.get(record.uuid);
    if (existing) {
      try { existing.textarea.focus(); } catch (_) {}
      return;
    }
    // Single-edit policy: cancel any other open editor before opening a new one.
    for (const otherUuid of [...inlineEditByUuid.keys()]) {
      if (otherUuid !== record.uuid) cancelInlineEditor(otherUuid);
    }

    // Anchor-scroll setup. Raw markdown is taller than the rendered version,
    // so opening the editor pushes the row downward — the pencil that the
    // user just clicked goes off-screen, and the new ✓/✗ icons end up far
    // below where the click happened, breaking the "icons swapped in place"
    // affordance. Capture the original action row's viewport Y *before* any
    // DOM mutation, then re-align the scroll container after mutation so
    // the saveBtn lands at the same screen Y the pencil sat at.
    const anchorEl = originalActionRow || contentEl;
    const anchorTopBefore = anchorEl ? anchorEl.getBoundingClientRect().top : null;
    let scrollContainer = null;
    if (anchorEl) {
      let n = anchorEl.parentElement;
      while (n) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) {
          scrollContainer = n;
          break;
        }
        n = n.parentElement;
      }
      if (!scrollContainer) scrollContainer = document.scrollingElement || document.documentElement;
    }

    const shell = document.createElement('div');
    shell.className = 'incipit-inline-edit-shell';
    shell.setAttribute('data-incipit-inline-edit-shell', kind);

    // For user kind, build the chip strip + extract prose-only text.
    // Refs (ide_opened_file / ide_selection) and image attachments
    // become chips above the textarea; the textarea holds only the
    // user's typed prose. Assistant edits are pure text — no chips.
    let chipsContainer = null;
    let chipsAddBtn = null;
    let chipsFileInput = null;
    let initialChips = [];
    let textareaInitial = initialText || '';
    if (kind === 'user') {
      const classified = classifyUserRecordBlocks(record);
      initialChips = classified.chips;
      // Override caller's initialText (which joined all text blocks
      // including the ide_* wrappers) with prose-only text. Wrappers
      // round-trip via keep-by-index, not by being typed back into
      // the textarea — typing them as text would let the user
      // accidentally synthesize fake refs the host must reject.
      textareaInitial = classified.proseText;

      chipsContainer = document.createElement('div');
      chipsContainer.className = 'incipit-edit-chip-strip';
      chipsContainer.setAttribute('data-incipit-inline-edit-chips', '');
      shell.appendChild(chipsContainer);

      // '+' add-image button + hidden file input (multiple file pick).
      // Paste/drop work too; the visible '+' is just affordance.
      chipsFileInput = document.createElement('input');
      chipsFileInput.type = 'file';
      chipsFileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
      chipsFileInput.multiple = true;
      chipsFileInput.style.display = 'none';
      shell.appendChild(chipsFileInput);

      chipsAddBtn = document.createElement('button');
      chipsAddBtn.className = 'incipit-edit-chip-add';
      chipsAddBtn.type = 'button';
      chipsAddBtn.title = legacyText('attach_image_hint');
      chipsAddBtn.setAttribute('aria-label', legacyText('attach_image'));
      chipsAddBtn.innerHTML = CHIP_PLUS_ICON_SVG;
      chipsAddBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        chipsFileInput.value = '';
        chipsFileInput.click();
      });
      chipsFileInput.addEventListener('change', () => {
        const state = inlineEditByUuid.get(record.uuid);
        if (!state) return;
        for (const f of Array.from(chipsFileInput.files || [])) {
          addInlineEditImageFromFile(state, f);
        }
      });
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'incipit-inline-edit-textarea';
    textarea.setAttribute('data-incipit-inline-edit-textarea', '');
    textarea.spellcheck = false;
    textarea.value = textareaInitial;
    textarea.rows = 1;
    shell.appendChild(textarea);

    // Image paste/drop handlers (user kind only). Paste captures
    // clipboardData image items; drop captures dragged-in files.
    // Text paste falls through to the textarea's natural behaviour.
    if (kind === 'user') {
      textarea.addEventListener('paste', (ev) => {
        const items = (ev.clipboardData && ev.clipboardData.items) || [];
        let handled = false;
        const state = inlineEditByUuid.get(record.uuid);
        for (const it of items) {
          if (it.kind === 'file' && /^image\//.test(it.type || '')) {
            const file = it.getAsFile && it.getAsFile();
            if (file && state) {
              addInlineEditImageFromFile(state, file);
              handled = true;
            }
          }
        }
        if (handled) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      });
      shell.addEventListener('dragover', (ev) => {
        // Only signal accept when an image-ish file is being dragged;
        // suppresses VS Code's editor-level default for image drops.
        const dt = ev.dataTransfer;
        if (!dt) return;
        const types = dt.types || [];
        const looksLikeFile = Array.prototype.indexOf.call(types, 'Files') !== -1;
        if (looksLikeFile) {
          ev.preventDefault();
          ev.stopPropagation();
          try { dt.dropEffect = 'copy'; } catch (_) {}
        }
      });
      shell.addEventListener('drop', (ev) => {
        const dt = ev.dataTransfer;
        if (!dt) return;
        const files = Array.from(dt.files || []).filter(f => /^image\//.test(f.type || ''));
        if (!files.length) return;
        ev.preventDefault();
        ev.stopPropagation();
        const state = inlineEditByUuid.get(record.uuid);
        if (!state) return;
        for (const f of files) addInlineEditImageFromFile(state, f);
      });
    }

    const editActions = document.createElement('div');
    editActions.className = 'incipit-transcript-action-row incipit-inline-edit-actions';
    editActions.setAttribute('data-incipit-inline-edit-actions', kind);

    // SVG icon buttons (matching the original three-icon row family).
    // makeTranscriptActionButton wires stopPropagation, the
    // `data-incipit-disabled` swallow guard, and stashes _incipitLive*
    // for reuse by busy-state flips.
    const cancelBtn = makeTranscriptActionButton(
      'cancel',
      legacyText('cancel_edit_esc'),
      CANCEL_ICON_SVG,
      () => cancelInlineEditor(record.uuid),
    );
    const saveBtn = makeTranscriptActionButton(
      'save',
      legacyText('save_ctrl_enter'),
      SAVE_ICON_SVG,
      () => saveInlineEditor(record.uuid),
    );
    const saveRerunBtn = kind === 'user'
      ? makeTranscriptActionButton(
        'rerun',
        legacyText('save_rerun_ctrl_enter'),
        RERUN_ICON_SVG,
        () => saveAndRerunInlineEditor(record.uuid, saveRerunBtn),
      )
      : null;

    // When downstream assistant messages contain signed thinking blocks,
    // local-only Save is impossible (API rejects a modified upstream that
    // still carries stale thinking signatures — host-badge rejects it
    // too). Hide Save, keep only Cancel + Rerun so the user can't hit
    // that dead end. Read from messages.value, not DOM (virtualization).
    const hasDownstreamThinking =
      kind === 'user' && userRecordHasDownstreamSignedThinking(record);

    if (hasDownstreamThinking) {
      editActions.append(cancelBtn, saveRerunBtn);
    } else {
      editActions.append(cancelBtn, saveBtn);
      if (saveRerunBtn) editActions.appendChild(saveRerunBtn);
    }

    // DOM injection.
    // Shell — always adjacent to the content node it replaces.
    if (contentEl.parentElement) {
      contentEl.parentElement.insertBefore(shell, contentEl.nextSibling);
    } else {
      bubbleHost.appendChild(shell);
    }
    // Edit-actions — placement depends on kind:
    //  - user: inside the bubble itself, after the shell, so the
    //    cancel/save pair sits at the bottom-right of the expanded
    //    draft card (the bubble carries the visual identity).
    //  - assistant: outside the markdown root, next to the original
    //    icon row at message-host level, matching the original AI
    //    action row position (below the warm draft card).
    let editActionsPlaced = false;
    if (kind === 'user') {
      const userBubbleEl = contentEl.closest('[data-incipit-user-bubble]');
      if (userBubbleEl) {
        userBubbleEl.appendChild(editActions);
        editActionsPlaced = true;
      }
    }
    if (!editActionsPlaced) {
      if (originalActionRow && originalActionRow.parentElement) {
        originalActionRow.parentElement.insertBefore(editActions, originalActionRow.nextSibling);
      } else {
        bubbleHost.appendChild(editActions);
      }
    }

    // Hide originals via attr (CSS handles display:none).
    contentEl.setAttribute('data-incipit-inline-edit-hidden', '');
    if (originalActionRow) originalActionRow.setAttribute('data-incipit-inline-edit-hidden', '');
    // For user kind: also hide the host-rendered attachment pill row
    // (`[data-incipit-user-attachments]`). The host renders it either
    // inside the user bubble (short messages) or as a sibling above the
    // bubble (long messages). Without this hide, both the host's pills
    // *and* our chip strip render simultaneously, showing the same
    // images twice with two different visual styles. Scope query at the
    // userMessageContainer level to cover both layouts.
    let attachmentsEl = null;
    if (kind === 'user') {
      attachmentsEl = bubbleHost.querySelector(SEL.userAttachments);
      if (attachmentsEl) {
        attachmentsEl.setAttribute('data-incipit-inline-edit-hidden', '');
      }
    }
    bubbleHost.setAttribute('data-incipit-inline-editing', kind);

    const autoGrow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    };
    textarea.addEventListener('input', autoGrow);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelInlineEditor(record.uuid);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (hasDownstreamThinking) {
          saveAndRerunInlineEditor(record.uuid, saveRerunBtn);
        } else {
          saveInlineEditor(record.uuid);
        }
      }
    });
    inlineEditByUuid.set(record.uuid, {
      kind,
      record,
      bubbleHost,
      contentEl,
      shellEl: shell,
      textarea,
      saveBtn,
      saveRerunBtn,
      cancelBtn,
      editActionsEl: editActions,
      originalActionRow: originalActionRow || null,
      identity: identity || null,
      // Chip strip state (user kind only). chips is mutated in place
      // by removeInlineEditChip / addInlineEditImageFromFile;
      // renderInlineEditChipStrip clears + repaints `chipsContainerEl`
      // each time. chipsCounter namespace 'n-N' keeps new-image chip
      // ids distinct from the 'k-N' keep-chip ids minted by the
      // classifier, even though render uses chipId only as a DOM key.
      chips: initialChips,
      chipsContainerEl: chipsContainer,
      chipsAddBtn,
      chipsFileInput,
      chipsCounter: 0,
      attachmentsEl,
    });

    if (kind === 'user') {
      const seedState = inlineEditByUuid.get(record.uuid);
      renderInlineEditChipStrip(seedState);
    }

    applyInlineSaveBusyState(saveBtn, conversationIsBusy());

    // Realign the scroll container so the saveBtn sits at the same screen
    // Y the click target was at. Two passes — synchronous (covers shell
    // injection + contentEl hide) and post-autoGrow (covers textarea
    // expanding to its full scrollHeight). `preventScroll: true` on focus
    // is required: without it the browser does its own scrollIntoView on
    // the textarea and fights our anchor in the same tick.
    const realignToAnchor = () => {
      if (anchorTopBefore == null || !scrollContainer || !saveBtn) return;
      const r = saveBtn.getBoundingClientRect();
      if (!r.height) return;
      const delta = r.top - anchorTopBefore;
      if (Math.abs(delta) > 0.5) scrollContainer.scrollTop += delta;
    };
    realignToAnchor();

    // Focus + autosize on the next tick so layout has settled.
    setTimeout(() => {
      try {
        autoGrow();
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        realignToAnchor();
      } catch (_) {}
    }, 0);
  }

  const USER_CONTENT_EXCLUDE_SELECTOR = [
    SEL.userAttachments,
    '[class*="Attachments"]',
    '.claude-show-more-row',
    '.claude-user-copy-btn-row',
    '[data-incipit-action-dropdown]',
  ].join(', ');

  const USER_TEXT_CONTENT_SELECTOR = [
    SEL.userContent,
    '[class*="expandableContainer"] [class*="content_"]',
  ].join(', ');

  function userBubbleContentElement(bubbleEl) {
    if (!bubbleEl || !bubbleEl.querySelectorAll) return null;
    const candidates = Array.from(
      bubbleEl.querySelectorAll(USER_TEXT_CONTENT_SELECTOR)
    ).filter(el => (
      el &&
      el.nodeType === 1 &&
      !el.isContentEditable &&
      !el.closest(USER_CONTENT_EXCLUDE_SELECTOR)
    ));
    if (!candidates.length) return null;
    let best = null;
    let bestScore = -1;
    for (const el of candidates) {
      const textLen = (el.textContent || '').trim().length;
      const expandableBonus = el.closest('[class*="expandableContainer"]') ? 1000 : 0;
      const taggedBonus = el.matches(SEL.userContent) ? 2000 : 0;
      const score = taggedBonus + expandableBonus + textLen;
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  // Prefer the actual user text node, not attachment-chip internals. Fall
  // back to the bubble text with attachments and injected controls removed.
  function userBubbleText(bubbleEl) {
    const content = userBubbleContentElement(bubbleEl);
    if (content) return content.textContent || '';
    const clone = bubbleEl.cloneNode(true);
    clone.querySelectorAll(
      `${USER_CONTENT_EXCLUDE_SELECTOR}, .claude-user-copy-btn`
    ).forEach(n => n.remove());
    return clone.textContent || '';
  }

  // Walk upward to the outer `userMessageContainer`, which hosts the sibling row.
  function findUserMessageHost(bubbleEl) {
    return closestByAttr(bubbleEl, ATTR.userMessageContainer);
  }

  // Copy block, used as-is by AI-turn dropdowns and appended below
  // the rewind block on user-bubble dropdowns. `getMarkdown()` is
  // lazy so big-document text extraction doesn't run on every
  // reconcile.
  function buildCopyDropdownItems(getMarkdown) {
    return [
      {
        label: legacyText('copy_as_text'),
        icon: COPY_AS_TEXT_ICON_SVG,
        onClick: () => {
          const md = (getMarkdown() || '').toString();
          copyText(markdownToPlainText(md));
        },
      },
      {
        label: legacyText('copy_as_markdown'),
        icon: COPY_AS_MARKDOWN_ICON_SVG,
        onClick: () => {
          copyText((getMarkdown() || '').toString());
        },
      },
    ];
  }

  // User-bubble dropdown — five rewind/fork variants on top, then the
  // copy pair below a separator. `liveRecord` resolves uuid → current
  // Ez instance at click time (post-edit content, post-rerun staleness
  // both handled). `hasPrevUuid` lets us disable fork-with-rewind on
  // the very first user message; the `Fork` main button itself is
  // simply not added in that case (see addUserCopyButton).
  //
  // Rewind block disabled snapshot: streaming gates the entire
  // rewind/fork family. We snapshot once at popup-open time. If the
  // stream finishes while the popup is still open, the user closes
  // and reopens — cheap enough.
  function buildUserDropdownItems(liveRecord, getMarkdown, hasPrevUuid) {
    let busyAtOpen = false;
    try { busyAtOpen = conversationIsBusy(); } catch (_) { busyAtOpen = false; }
    const rewindBlocked = busyAtOpen;
    const forkBlocked = busyAtOpen || !hasPrevUuid;
    return [
      {
        label: legacyText('rerun_with_code_rewind'),
        icon: RERUN_ICON_SVG,
        disabled: rewindBlocked,
        title: rewindBlocked ? legacyText('disabled_while_streaming') : '',
        onClick: () => { rerunWithRewindFromUser(liveRecord(), null); },
      },
      {
        label: legacyText('fork_with_code_rewind'),
        icon: FORK_ICON_SVG,
        disabled: forkBlocked,
        title: forkBlocked
          ? (busyAtOpen ? legacyText('disabled_while_streaming') : legacyText('cannot_fork_first_message'))
          : '',
        onClick: () => { forkWithRewindFromUser(liveRecord(), null); },
      },
      {
        label: legacyText('rewind_code_only'),
        icon: REWIND_ONLY_ICON_SVG,
        disabled: rewindBlocked,
        title: rewindBlocked ? legacyText('disabled_while_streaming') : '',
        onClick: () => { rewindOnlyFromUser(liveRecord(), null); },
      },
      { type: 'separator' },
      ...buildCopyDropdownItems(getMarkdown),
    ];
  }

  // Every user bubble gets pencil + pen-nib rerun + more (copy
  // dropdown). Synthetic / tool-result-only "user" entries (rare —
  // tool results don't normally render through SEL.userBubble) only
  // get the more dropdown so copy still works without exposing
  // edit/rerun on a record that isn't really user input.
  function addUserCopyButton(bubbleEl) {
    const host = findUserMessageHost(bubbleEl);
    if (!host) return;
    if (host.querySelector(':scope > .claude-user-copy-btn-row')) return;
    const record = transcriptRecordForElement(host) || transcriptRecordForElement(bubbleEl);
    const row = document.createElement('div');
    row.className = 'claude-user-copy-btn-row incipit-transcript-action-row';

    const isRealUser = !!(
      record &&
      record.type === 'user' &&
      !record.isSynthetic &&
      !transcriptHasToolResult(record) &&
      !isCompactSummaryRecord(record) &&
      !isSlashCommandRecord(record)
    );
    const identity = isRealUser ? transcriptRecordIdentity(record) : null;
    // Closures below capture `record` once at decoration time; saving
    // an edit replaces the Ez instance in messages.value (uuid stable),
    // so always rehydrate by uuid before reading text.
    const capturedUuid = record && record.uuid;
    const liveRecord = () => liveTranscriptRecord(capturedUuid, record);
    const getMarkdown = () => {
      const t = isRealUser ? transcriptText(liveRecord()) : '';
      return t || userBubbleText(bubbleEl).trim();
    };

    if (isRealUser) {
      // Pencil — open inline editor for this user record.
      row.appendChild(makeTranscriptActionButton(
        'edit',
        legacyText('edit_user_message'),
        EDIT_ICON_SVG,
        () => {
          const cur = liveRecord();
          const userContentEl = userBubbleContentElement(bubbleEl) || bubbleEl;
          const initialText = transcriptText(cur) || userBubbleText(bubbleEl).trim();
          openInlineEditor({
            kind: 'user',
            record: cur,
            bubbleHost: host,
            contentEl: userContentEl,
            originalActionRow: row,
            identity,
            initialText,
          });
        }
      ));
      // Reprise arrow — rerun this turn. Drops everything from this user
      // forward and replays the text through the host's send pipeline.
      // rerunFromUser internally re-resolves to the live record and
      // toggles inflight on this button while the IPC roundtrip runs.
      // Identity is also re-derived inside rerunFromUser at click time
      // to avoid the closure-captured snapshot drifting under us in
      // multi-window setups.
      const rerunBtn = makeTranscriptActionButton(
        'rerun',
        legacyText('rerun_this_turn'),
        RERUN_ICON_SVG,
        () => { rerunFromUser(liveRecord(), rerunBtn); }
      );
      row.appendChild(rerunBtn);
      // Fork (git-branch Y) — clones the conversation at this point
      // into a new session and seeds it with this user's prose. The
      // current session is left untouched, so this is non-destructive
      // unlike rerun. We only mount the button when a prevUuid exists;
      // the host's fork API has no meaningful behaviour on the very
      // first user message (it would degrade to "create new session"
      // for which we don't have the host's onCreateNewSession callback
      // wired).
      const hasPrev = !!findPrevUuidForFork(record);
      if (hasPrev) {
        const forkBtn = makeTranscriptActionButton(
          'fork',
          legacyText('fork_conversation_from_here'),
          FORK_ICON_SVG,
          () => { forkFromUser(liveRecord(), forkBtn); }
        );
        row.appendChild(forkBtn);
      }
    }

    // More — always present. User bubbles get the full rewind/fork
    // dropdown plus copy pair; tool-result-only "user" entries get
    // copy only (real-user gate above), so we pick the right builder
    // here at popup-open time.
    const moreBtn = makeTranscriptActionButton(
      'more',
      legacyText('more_actions'),
      MORE_ICON_SVG,
      () => {
        if (isRealUser) {
          const hasPrev = !!findPrevUuidForFork(liveRecord());
          openActionDropdown(moreBtn, buildUserDropdownItems(liveRecord, getMarkdown, hasPrev));
        } else {
          openActionDropdown(moreBtn, buildCopyDropdownItems(getMarkdown));
        }
      }
    );
    row.appendChild(moreBtn);

    host.appendChild(row);
  }

  // ---- custom show-more handling ----
  //
  // Measure the bubble, classify it as `short` or `long`, and replace the
  // host truncation UI with a custom show-more row when needed.
  const LONG_THRESHOLD_PX = 600;
  const NATIVE_USER_BUBBLE_EXPAND_SELECTOR =
    '[class*="contentWrapper_"][class*="clickable_"], ' +
    '[class*="expandButton_"], [class*="collapseButton_"]';
  const NATIVE_USER_BUBBLE_CLICK_ALLOW_SELECTOR = [
    '.claude-show-more-row',
    '.claude-user-copy-btn-row',
    '.incipit-transcript-action-row',
    '[data-incipit-action-dropdown]',
    'a[href]',
    'button:not([class*="expandButton_"]):not([class*="collapseButton_"])',
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
  ].join(', ');

  // Walk up to find the nearest scrollable ancestor. Falls back to `window`
  // if no ancestor scrolls. Claude Code keeps the transcript in an overflow
  // container, so show-less anchor compensation cannot rely on window.scrollBy
  // alone.
  function findScrollAncestor(el) {
    let p = el.parentElement;
    while (p) {
      const s = getComputedStyle(p);
      const oy = s.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          p.scrollHeight > p.clientHeight) {
        return p;
      }
      p = p.parentElement;
    }
    return window;
  }

  function preserveScrollAnchor(el, beforeTop) {
    if (!el) return;
    const afterTop = el.getBoundingClientRect().top;
    const delta = afterTop - beforeTop;
    if (delta !== 0) {
      const scroller = findScrollAncestor(el);
      if (scroller === window) window.scrollBy(0, delta);
      else scroller.scrollTop += delta;
    }
  }

  function addShowMoreRow(bubble) {
    if (bubble.querySelector(':scope > .claude-show-more-row')) return;
    const row = document.createElement('div');
    row.className = 'claude-show-more-row';
    const btn = document.createElement('button');
    btn.className = 'claude-show-more-btn';
    btn.type = 'button';
    btn.textContent = legacyText('show_more');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const expanded = bubble.getAttribute('data-claude-expanded') === '1';
      if (expanded) {
        const beforeTop = btn.getBoundingClientRect().top;
        bubble.removeAttribute('data-claude-expanded');
        btn.textContent = legacyText('show_more');
        preserveScrollAnchor(btn, beforeTop);
      } else {
        bubble.setAttribute('data-claude-expanded', '1');
        btn.textContent = legacyText('show_less');
      }
    });
    row.appendChild(btn);
    bubble.appendChild(row);
  }

  function suppressNativeUserBubbleExpandClick(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const nativeExpand = target.closest(NATIVE_USER_BUBBLE_EXPAND_SELECTOR);
    if (!nativeExpand || !nativeExpand.closest(SEL.userBubble)) return;
    if (target.closest(NATIVE_USER_BUBBLE_CLICK_ALLOW_SELECTOR)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function setupUserBubbleNativeActionSuppression() {
    document.addEventListener('click', suppressNativeUserBubbleExpandClick, true);
  }

  function classifyUserBubble(bubble) {
    const existing = bubble.getAttribute('data-claude-length');
    if (existing === 'short' || existing === 'long') return;
    const content = userBubbleContentElement(bubble);
    if (!content) return;
    // Temporarily remove clipping to measure the natural height.
    bubble.setAttribute('data-claude-length', 'measuring');
    const h = content.scrollHeight;
    if (h === 0) {
      // Layout is not ready yet. Clear the marker and retry on the next scan.
      bubble.removeAttribute('data-claude-length');
      return;
    }
    if (h <= LONG_THRESHOLD_PX) {
      bubble.setAttribute('data-claude-length', 'short');
    } else {
      bubble.setAttribute('data-claude-length', 'long');
      addShowMoreRow(bubble);
    }
  }

  function findAssistantActionHost(markdownRoot) {
    const message = closestByAttr(markdownRoot, ATTR.message) ||
      (markdownRoot.closest && markdownRoot.closest('[class*="timelineMessage"]'));
    if (!message) return null;
    if (message.closest(SEL.userMessageContainer) ||
        message.closest('[class*="userMessageContainer"]')) return null;
    if (markdownRoot.closest(SEL.toolUse)) return null;
    if (markdownRoot.closest(SEL.thinking) ||
        markdownRoot.closest(SEL.thinkingSummary) ||
        markdownRoot.closest(SEL.thinkingContent) ||
        markdownRoot.closest('[class*="thinking"]')) return null;
    return message;
  }

  // A jsonl transcript splits one user-visible AI reply into many
  // assistant records (thinking / text / tool_use each become a record
  // sharing the same `requestId`). The action row should appear once
  // per turn, on the *last* assistant record before the next real user
  // input — not on every text record in the middle. tool_result-only
  // user records are tool roundtrips, not turn breaks.
  function isLastAssistantOfTurn(record) {
    if (!record || record.type !== 'assistant') return false;
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages)) return true;
    const idx = transcriptRecordIndex(messages, record);
    if (idx < 0) return true;
    for (let i = idx + 1; i < messages.length; i++) {
      const next = messages[i];
      if (!next || typeof next !== 'object') continue;
      const t = next.type;
      if (t === 'assistant') return false;
      if (t === 'user') {
        if (transcriptHasToolResult(next)) continue;
        return true;
      }
    }
    return true;
  }

  function lastAssistantTextRecordOfTurn() {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'assistant') {
        return transcriptHasText(m) && isLastAssistantOfTurn(m) ? m : null;
      }
      if (m.type === 'user' && transcriptHasToolResult(m)) continue;
      if (m.type === 'progress' || m.type === 'system') continue;
      return null;
    }
    return null;
  }

  function recordUuid(record) {
    return (typeof record?.uuid === 'string' && record.uuid) ? record.uuid : '';
  }

  function recordBetaMessageId(record) {
    return (typeof record?.betaMessageId === 'string' && record.betaMessageId)
      ? record.betaMessageId
      : '';
  }

  function sameTranscriptRecord(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const uuid = recordUuid(a);
    if (uuid && uuid === recordUuid(b)) return true;
    const beta = recordBetaMessageId(a);
    return !!(beta && beta === recordBetaMessageId(b));
  }

  function transcriptRecordIndex(messages, record) {
    if (!Array.isArray(messages) || !record) return -1;
    let idx = messages.findIndex(m => m === record);
    if (idx >= 0) return idx;
    const uuid = recordUuid(record);
    if (uuid) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (recordUuid(messages[i]) === uuid) return i;
      }
    }
    const beta = recordBetaMessageId(record);
    if (beta) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (recordBetaMessageId(messages[i]) === beta) return i;
      }
    }
    return -1;
  }

  function latestRealUserMessageIndex(messages) {
    if (!Array.isArray(messages) || !messages.length) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'progress' || m.type === 'system') continue;
      if (m.type === 'user' && transcriptHasToolResult(m)) continue;
      return m.type === 'user' ? i : -1;
    }
    return -1;
  }

  function latestRealUserTurnKey() {
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    const idx = latestRealUserMessageIndex(messages);
    return idx >= 0 ? recordUuid(messages[idx]) : '';
  }

  function recordBelongsToCurrentBusyTurn(record) {
    if (!record || record.type !== 'assistant') return false;
    if (!conversationIsBusy()) return false;
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || !messages.length) return false;
    const userIdx = latestRealUserMessageIndex(messages);
    if (userIdx < 0) return false;
    const recordIdx = transcriptRecordIndex(messages, record);
    return recordIdx > userIdx;
  }

  function normalizeActionText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function markdownRootMatchesRecord(root, record) {
    if (!root || !record) return false;
    const recordText = normalizeActionText(transcriptText(record));
    const rootText = normalizeActionText(root.textContent || '');
    if (!recordText || !rootText) return false;
    if (rootText === recordText) return true;
    const tail = recordText.slice(Math.max(0, recordText.length - 240));
    return tail.length >= 24 && rootText.includes(tail);
  }

  function lastAssistantMarkdownRoot(record = null) {
    const roots = Array.from(document.querySelectorAll(SEL.markdownRoot));
    let fallback = null;
    for (let i = roots.length - 1; i >= 0; i--) {
      const root = roots[i];
      if (!root || !root.isConnected) continue;
      if (!findAssistantActionHost(root)) continue;
      if (!fallback) fallback = root;
      if (!record || markdownRootMatchesRecord(root, record)) return root;
    }
    return record ? null : fallback;
  }

  function placeAssistantActionRow(host, markdownRoot, row) {
    if (!host || !markdownRoot || !row) return;
    let moved = false;
    let anchor = markdownRoot;
    while (anchor.parentElement && anchor.parentElement !== host) {
      anchor = anchor.parentElement;
    }
    if (anchor.parentElement === host) {
      if (anchor.nextSibling !== row) {
        host.insertBefore(row, anchor.nextSibling);
        moved = true;
      }
      if (moved && changeReviewTurns().length && !changeReviewBusySafe()) scheduleChangeReviewTurnBlocksRender();
      return;
    }
    if (row.parentElement !== host || row.nextSibling) {
      host.appendChild(row);
      moved = true;
    }
    if (moved && changeReviewTurns().length && !changeReviewBusySafe()) scheduleChangeReviewTurnBlocksRender();
  }

  // Returns true when the record is the trailing assistant of the
  // *current* (still-streaming) turn — i.e. busy=true AND this record
  // sits at the tail of `messages.value` (skipping tool_result-only
  // user records as tool roundtrips). We refuse to decorate this case
  // because the "turn end" is still moving; a row pinned now would
  // either flicker mid-stream or end up on the wrong block. Past turns
  // (real user input present after this record) stay decorated; sweep
  // marks their edit/delete disabled until streaming ends.
  function isCurrentlyStreamingRecord(record) {
    if (!record || record.type !== 'assistant') return false;
    if (!conversationIsBusy()) return false;
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    if (!Array.isArray(messages) || messages.length === 0) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.type === 'assistant') return sameTranscriptRecord(m, record);
      if (m.type === 'user' && transcriptHasToolResult(m)) continue;
      return false;
    }
    return false;
  }

  // AI text turns get a 2-icon row at the markdown end: pencil (edit
  // local transcript) + more (copy as text/markdown). No delete:
  // destructive operations live on user bubbles only, where they have
  // a clean truncate-and-rerun semantic. No standalone copy: copy
  // sits inside the more dropdown. Mid-turn assistant records
  // (thinking / tool_use / interrupted-tool-end) get nothing — the
  // turn boundary is the user's input, not the assistant's last block.
  function reconcileAssistantTranscriptActions(markdownRoot, fallbackRecord = null) {
    const host = findAssistantActionHost(markdownRoot);
    if (!host) return;
    const domRecord = transcriptRecordForElement(host) || transcriptRecordForElement(markdownRoot);
    const existingRow = host.querySelector(':scope > .incipit-assistant-action-row');
    // Fast path: row already decorated. Once a record is the last
    // assistant text of its turn, that property is monotone (records
    // are append-only; rerun unmounts the corresponding DOM, taking
    // the row with it). So we can skip the fiber pierce + O(N)
    // isLastAssistantOfTurn scan entirely, and only do the cheap
    // placement check + busy-state sync. Without this short-circuit
    // the post-mutation burst (`runTranscriptActionScanBurst`) repeats
    // those expensive resolves once per markdown root × 14 frames,
    // producing the 2–3 s freeze users see after /compact, Enter,
    // and Interrupt. Idle→busy transitions still flip past-turn rows
    // to disabled via the busy-state observer's `cleanupDuringBusy`.
    if (existingRow) {
      const existingRecord = domRecord || fallbackRecord;
      if (recordBelongsToCurrentBusyTurn(existingRecord)) {
        existingRow.remove();
        removeCurrentBusyChangeReviewTurnBlocks();
        return;
      }
      placeAssistantActionRow(host, markdownRoot, existingRow);
      existingRow.querySelectorAll('.incipit-transcript-action-btn')
        .forEach(b => applyButtonBusyState(b, conversationIsBusy()));
      return;
    }
    const domRecordLooksFinal = !!(
      domRecord &&
      domRecord.type === 'assistant' &&
      transcriptHasText(domRecord) &&
      isLastAssistantOfTurn(domRecord)
    );
    const record = domRecordLooksFinal ? domRecord : (fallbackRecord || domRecord);
    const shouldShow = !!(
      record &&
      record.type === 'assistant' &&
      transcriptHasText(record) &&
      isLastAssistantOfTurn(record) &&
      !recordBelongsToCurrentBusyTurn(record)
    );
    if (!shouldShow) return;
    // Iron streaming gate: never mint a brand-new row while a reply is in
    // flight. Streaming mutations only mark the transcript dirty; the
    // settle scanner materialises final assistant rows after idle + quiet.
    if (conversationIsBusy()) return;

    const row = document.createElement('div');
    row.className = 'incipit-transcript-action-row incipit-assistant-action-row';
    const identity = transcriptRecordIdentity(record);
    // Re-resolve the record by uuid at click time — see addUserCopyButton.
    const capturedUuid = record && record.uuid;
    const liveRecord = () => liveTranscriptRecord(capturedUuid, record);
    const getMarkdown = () => transcriptText(liveRecord()) || markdownRoot.textContent || '';

    const editBtn = makeTranscriptActionButton('edit', legacyText('edit_assistant_message'), EDIT_ICON_SVG, async () => {
      let cur = liveRecord();
      cur = await ensureAssistantRecordUuid(cur);
      if (!cur || !recordUuid(cur)) {
        showTranscriptToast(legacyText('local_history_syncing'), 'warn');
        noteTranscriptActionMutation();
        return;
      }
      openInlineEditor({
        kind: 'assistant',
        record: cur,
        bubbleHost: host,
        contentEl: markdownRoot,
        originalActionRow: row,
        identity: transcriptRecordIdentity(cur) || identity,
        initialText: transcriptText(cur) || markdownRoot.textContent || '',
      });
    });
    row.appendChild(editBtn);
    // Edit hover preview: hover the pencil → markdown root paints with
    // the inline-edit draft-card colour (same as a real edit click
    // produces). Skip when disabled by streaming gate; idle→busy
    // transition also clears the attr eagerly elsewhere so hover-in-
    // flight doesn't linger on a now-disabled icon.
    editBtn.addEventListener('mouseenter', () => {
      if (editBtn.dataset.incipitDisabled === '1') return;
      markdownRoot.setAttribute('data-incipit-edit-hover-preview', '1');
    });
    editBtn.addEventListener('mouseleave', () => {
      markdownRoot.removeAttribute('data-incipit-edit-hover-preview');
    });

    const moreBtn = makeTranscriptActionButton('more', legacyText('more_actions'), MORE_ICON_SVG, () => {
      openActionDropdown(moreBtn, buildCopyDropdownItems(getMarkdown));
    });
    row.appendChild(moreBtn);

    placeAssistantActionRow(host, markdownRoot, row);
  }

  function removeCurrentBusyAssistantTerminalDecorations() {
    if (!conversationIsBusy()) return;
    document.querySelectorAll('.incipit-assistant-action-row').forEach(row => {
      const host = row.parentElement;
      if (!host || !host.isConnected) return;
      const record = transcriptRecordForElement(host);
      if (!recordBelongsToCurrentBusyTurn(record)) return;
      row.remove();
    });
    removeCurrentBusyChangeReviewTurnBlocks();
  }

  function scanAssistantTranscriptActions(root) {
    const scope = root || document.body;
    if (!scope) return;
    if (scope.matches && scope.matches(SEL.markdownRoot)) reconcileAssistantTranscriptActions(scope);
    if (scope.querySelectorAll) {
      const markdownRoots = scope.querySelectorAll(SEL.markdownRoot);
      for (const markdownRoot of markdownRoots) reconcileAssistantTranscriptActions(markdownRoot);
    }
    if (!conversationIsBusy()) {
      // Final text rows can miss the normal DOM→fiber record lookup: React may
      // have committed the markdown DOM before the exact message record is
      // discoverable from that node. The active SessionState is canonical, so
      // use it as a fallback for the *last* assistant markdown root only.
      const fallbackRecord = lastAssistantTextRecordOfTurn();
      const fallbackRoot = fallbackRecord && lastAssistantMarkdownRoot(fallbackRecord);
      if (fallbackRoot) reconcileAssistantTranscriptActions(fallbackRoot, fallbackRecord);
    }
    sweepStreamingDisableState();
  }

  function scanAndAddCopyButtons(root, options = {}) {
    const scope = root || document.body;
    if (!scope) return;
    const assistantActions = options.assistantActions !== false;
    const handle = (bubble) => {
      // Interrupted messages are not real user input.
      if (bubble.querySelector(SEL.interruptedMessage)) return;
      addUserCopyButton(bubble);
      classifyUserBubble(bubble);
    };
    if (scope.matches && scope.matches(SEL.userBubble)) handle(scope);
    if (!scope.querySelectorAll) return;
    const userBubbles = scope.querySelectorAll(SEL.userBubble);
    for (const bubble of userBubbles) handle(bubble);
    if (assistantActions) {
      scanAssistantTranscriptActions(scope);
    } else if (options.sweepBusyState !== false) {
      // Sweep at the end so newly-mounted user-bubble rows (created above
      // by addUserCopyButton) snap to the current busy state in the same
      // mutation flush. Cheap: applyButtonBusyState early-returns on no-op.
      sweepStreamingDisableState();
    }
  }

  function transcriptActionRecordSummary(record) {
    if (!record) return null;
    return {
      uuid: record.uuid || null,
      betaMessageId: record.betaMessageId || null,
      type: record.type || null,
      hasText: transcriptHasText(record),
      partial: transcriptRecordHasPartialContent(record),
      lastAssistant: record.type === 'assistant' ? isLastAssistantOfTurn(record) : false,
      textTail: transcriptText(record).slice(-120),
    };
  }

  function diagnoseTranscriptActions() {
    const fallbackRecord = lastAssistantTextRecordOfTurn();
    const fallbackRoot = fallbackRecord && lastAssistantMarkdownRoot(fallbackRecord);
    const host = fallbackRoot && findAssistantActionHost(fallbackRoot);
    const domRecord = host
      ? (transcriptRecordForElement(host) || transcriptRecordForElement(fallbackRoot))
      : null;
    const session = locateActiveSessionState();
    const messages = session && session.messages && session.messages.value;
    const tail = Array.isArray(messages)
      ? messages.slice(-8).map(m => transcriptActionRecordSummary(m))
      : null;
    return {
      busy: conversationIsBusy(),
      sessionBusy: activeSessionBusyState(),
      sendButtonState: sendButtonDomState(),
      partialTail: activeSessionHasPartialTail(),
      quietFor: Math.round(nowMs() - lastTranscriptMutationAt),
      markdownRoots: document.querySelectorAll(SEL.markdownRoot).length,
      fallbackRecord: transcriptActionRecordSummary(fallbackRecord),
      fallbackRoot: fallbackRoot ? {
        textTail: (fallbackRoot.textContent || '').slice(-160),
        hasHost: !!host,
        hasExistingRow: !!(host && host.querySelector(':scope > .incipit-assistant-action-row')),
      } : null,
      domRecord: transcriptActionRecordSummary(domRecord),
      tail,
    };
  }

  function setupTranscriptActionDebugTools() {
    try {
      window.__incipitTranscriptActions = {
        rescan: () => scanAssistantTranscriptActions(document.body),
        diagnose: diagnoseTranscriptActions,
      };
    } catch (_) {}
  }

  // ========== 8a. Permission request collapse panel ==========
  //
  // Claude Code's AskUserQuestion permission UI shares the generic
  // permissionRequestContainer shell, then renders a navigation strip and a
  // questionsContainer inside it. Generic permission shells are themed in CSS;
  // this JS enhancement adds the shared collapse UI to Ask and Plan/Edit
  // approval panels, while Ask alone gets the navigator-aware button position.
  const ASK_PERMISSION_CONTAINER_SELECTOR = '[class*="permissionRequestContainer_"]';
  const ASK_QUESTIONS_SELECTOR = '[class*="questionsContainer_"]';
  const ASK_NAV_SELECTOR = '[class*="navigationBar_"]';
  const ASK_CLOSE_SELECTOR = 'button[aria-label="Close"]';
  const ASK_TITLE_SELECTOR = '[class*="questionTextLarge_"]';
  const ASK_NAV_TAB_SELECTOR = '[class*="navTab_"]';
  const ASK_NAV_LABEL_SELECTOR = '[class*="navTabLabel_"]';
  const ASK_ACTIVE_TAB_SELECTOR = '[class*="navTabActive_"]';

  const pendingAskRequests = new Set();
  const observedAskRequests = new WeakSet();
  let askRequestScanScheduled = false;

  function isPermissionRequestContainer(el) {
    return !!(
      el &&
      el.nodeType === 1 &&
      el.matches &&
      el.matches(ASK_PERMISSION_CONTAINER_SELECTOR)
    );
  }

  function isAskRequestContainer(el) {
    return !!(
      isPermissionRequestContainer(el) &&
      el.querySelector &&
      el.querySelector(ASK_QUESTIONS_SELECTOR)
    );
  }

  function closestPermissionRequestContainer(el) {
    if (!el || !el.closest) return null;
    const container = el.closest(ASK_PERMISSION_CONTAINER_SELECTOR);
    return isPermissionRequestContainer(container) ? container : null;
  }

  function permissionRequestTitle(container) {
    const question = container.querySelector(ASK_TITLE_SELECTOR);
    const text = question && question.textContent ? question.textContent.trim() : '';
    if (text) return text;
    const active = container.querySelector(`${ASK_ACTIVE_TAB_SELECTOR} ${ASK_NAV_LABEL_SELECTOR}`);
    const activeText = active && active.textContent ? active.textContent.trim() : '';
    if (activeText) return activeText;
    const content = container.querySelector('[class*="permissionRequestContent_"]') || container;
    const titled = content.querySelector(
      '[class*="permissionRequestTitle_"], [class*="questionText_"], ' +
      '[class*="title_"], h1, h2, h3, strong',
    );
    const titledText = titled && titled.textContent ? titled.textContent.trim() : '';
    if (titledText) return titledText;
    const firstLine = String(content.textContent || '')
      .split(/\n+/)
      .map(line => line.trim())
      .find(line => line && !/^(esc|escape)\b/i.test(line));
    return firstLine || legacyText('permission_request_fallback');
  }

  function permissionRequestPosition(container) {
    const tabs = Array.from(container.querySelectorAll(ASK_NAV_TAB_SELECTOR))
      .filter(tab => tab.querySelector && tab.querySelector(ASK_NAV_LABEL_SELECTOR));
    if (tabs.length <= 1) return '';
    const activeIndex = tabs.findIndex(tab => tab.matches && tab.matches(ASK_ACTIVE_TAB_SELECTOR));
    const index = activeIndex >= 0 ? activeIndex + 1 : 1;
    return `${index}/${tabs.length}`;
  }

  function askMessagesScroller() {
    const candidates = [
      document.querySelector(SEL.messagesContainer),
      ...document.querySelectorAll('[class*="messagesContainer_"]'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.scrollHeight > candidate.clientHeight + 1) return candidate;
    }
    return null;
  }

  function captureAskScrollState() {
    const scroller = askMessagesScroller();
    if (!scroller) return null;
    const distanceToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distanceToBottom <= 4) return null;
    return { scroller, scrollTop: scroller.scrollTop };
  }

  function restoreAskScrollState(state) {
    if (!state || !state.scroller || !state.scroller.isConnected) return;
    const maxScrollTop = Math.max(0, state.scroller.scrollHeight - state.scroller.clientHeight);
    state.scroller.scrollTop = Math.min(state.scrollTop, maxScrollTop);
  }

  function scheduleAskScrollRestore(state) {
    if (!state) return;
    restoreAskScrollState(state);
    requestAnimationFrame(() => {
      restoreAskScrollState(state);
      requestAnimationFrame(() => restoreAskScrollState(state));
    });
    setTimeout(() => restoreAskScrollState(state), 50);
    setTimeout(() => restoreAskScrollState(state), 140);
  }

  function setAskRequestCollapsed(container, collapsed) {
    if (!container) return;
    const scrollState = captureAskScrollState();
    if (collapsed) {
      container.setAttribute('data-incipit-permission-collapsed', '1');
      if (isAskRequestContainer(container)) container.setAttribute('data-incipit-ask-collapsed', '1');
    } else {
      container.removeAttribute('data-incipit-permission-collapsed');
      container.removeAttribute('data-incipit-ask-collapsed');
    }
    const toggle = container.querySelector('[data-incipit-permission-collapse-btn], [data-incipit-ask-collapse-btn]');
    if (toggle) {
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    }
    const bar = container.querySelector('[data-incipit-permission-collapsed-bar], [data-incipit-ask-collapsed-bar]');
    if (collapsed) {
      try { (bar || container).focus({ preventScroll: true }); } catch (_) {}
    } else {
      requestAnimationFrame(() => {
        const first = container.querySelector(
          '[role="radio"], [role="checkbox"], ' +
          'button:not([data-incipit-permission-collapse-btn]):not([data-incipit-ask-collapse-btn]), ' +
          'input:not([type="hidden"]), textarea',
        );
        try { first && first.focus && first.focus({ preventScroll: true }); } catch (_) {}
      });
    }
    scheduleAskScrollRestore(scrollState);
  }

  function ensureAskCollapsedBar(container) {
    let bar = container.querySelector(':scope > [data-incipit-permission-collapsed-bar], :scope > [data-incipit-ask-collapsed-bar]');
    if (!bar) {
      bar = document.createElement('button');
      bar.type = 'button';
      bar.className = 'incipit-ask-collapsed-bar incipit-permission-collapsed-bar';
      bar.setAttribute('data-incipit-permission-collapsed-bar', '');
      bar.setAttribute('data-incipit-ask-collapsed-bar', '');
      bar.setAttribute('aria-label', legacyText('expand_permission_panel'));
      const title = document.createElement('span');
      title.className = 'incipit-ask-collapsed-title incipit-permission-collapsed-title';
      const meta = document.createElement('span');
      meta.className = 'incipit-ask-collapsed-meta incipit-permission-collapsed-meta';
      bar.appendChild(title);
      bar.appendChild(meta);
      bar.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        setAskRequestCollapsed(container, false);
      });
      container.appendChild(bar);
    }
    const title = bar.querySelector('.incipit-ask-collapsed-title');
    const meta = bar.querySelector('.incipit-ask-collapsed-meta');
    if (title) title.textContent = permissionRequestTitle(container);
    if (meta) meta.textContent = permissionRequestPosition(container);
    return bar;
  }

  function ensureAskCollapseButton(container) {
    const nav = container.querySelector(ASK_NAV_SELECTOR);
    let btn = container.querySelector('[data-incipit-permission-collapse-btn], [data-incipit-ask-collapse-btn]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'incipit-ask-collapse-btn incipit-permission-collapse-btn';
      btn.setAttribute('data-incipit-permission-collapse-btn', '');
      btn.setAttribute('data-incipit-ask-collapse-btn', '');
      btn.setAttribute('aria-label', legacyText('collapse_permission_panel'));
      btn.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        setAskRequestCollapsed(container, true);
      });
    }
    if (nav && btn.parentElement !== nav) {
      btn.removeAttribute('data-incipit-permission-floating');
      container.removeAttribute('data-incipit-permission-floating-collapse');
      const close = nav.querySelector(ASK_CLOSE_SELECTOR);
      nav.insertBefore(btn, close || null);
    } else if (nav) {
      btn.removeAttribute('data-incipit-permission-floating');
      container.removeAttribute('data-incipit-permission-floating-collapse');
    } else {
      btn.setAttribute('data-incipit-permission-floating', '');
      container.setAttribute('data-incipit-permission-floating-collapse', '1');
      if (btn.parentElement !== container) container.appendChild(btn);
    }
    btn.setAttribute(
      'aria-expanded',
      container.getAttribute('data-incipit-permission-collapsed') === '1' ? 'false' : 'true',
    );
    btn.title = container.getAttribute('data-incipit-permission-collapsed') === '1'
      ? legacyText('expand')
      : legacyText('collapse');
    return btn;
  }

  function decorateAskRequest(container) {
    if (!isPermissionRequestContainer(container)) return;
    container.setAttribute('data-incipit-permission-request', '');
    if (isAskRequestContainer(container)) container.setAttribute('data-incipit-ask-request', '');
    else container.removeAttribute('data-incipit-ask-request');
    ensureAskCollapsedBar(container);
    ensureAskCollapseButton(container);
    observeAskRequestContainer(container);
  }

  function observeAskRequestContainer(container) {
    if (!container || observedAskRequests.has(container)) return;
    observedAskRequests.add(container);
    const localObserver = new MutationObserver(() => enqueueAskRequestContainer(container));
    localObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-checked'],
    });
    container.__incipitAskRequestObserver = localObserver;
  }

  function enqueueAskRequestContainer(container) {
    if (!container || pendingAskRequests.has(container)) return;
    pendingAskRequests.add(container);
    if (askRequestScanScheduled) return;
    askRequestScanScheduled = true;
    requestAnimationFrame(() => {
      askRequestScanScheduled = false;
      const items = Array.from(pendingAskRequests);
      pendingAskRequests.clear();
      for (const item of items) {
        if (!item.isConnected) continue;
        try { decorateAskRequest(item); } catch (_) {}
      }
    });
  }

  // Cheap "does this subtree carry a permission panel" test -
  // `matches` then a scoped `querySelector`, mirroring `nodeTouchesDiff`.
  // For streamed prose nodes the subtree is tiny and this returns null
  // fast; the point is to avoid the ancestor-walk-to-<body> below.
  function nodeTouchesAsk(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches?.(ASK_PERMISSION_CONTAINER_SELECTOR)) return true;
    return node.querySelector?.(ASK_PERMISSION_CONTAINER_SELECTOR) != null;
  }

  function mutationTouchesAskSurface(m) {
    if (!m || m.type !== 'childList') return false;
    if (nodeTouchesPermissionRequest(m.target)) return true;
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && nodeTouchesAsk(node)) return true;
    }
    for (const node of m.removedNodes) {
      if (node.nodeType === 1 && nodeTouchesAsk(node)) return true;
    }
    return false;
  }

  // Is a permission panel currently mounted anywhere? Recomputed only
  // when a mutation actually adds/removes a permission subtree (rare), so the
  // streaming hot path never pays the `document.querySelector`.
  let askActive = false;

  function enqueueAskRequestRoots(root, includeDescendants = true) {
    if (!root || root.nodeType !== 1) return;
    if (isPermissionRequestContainer(root)) enqueueAskRequestContainer(root);
    const closest = closestPermissionRequestContainer(root);
    if (closest) enqueueAskRequestContainer(closest);
    if (!includeDescendants || !root.querySelector) return;
    if (root === document.body && root.querySelectorAll) {
      root.querySelectorAll(ASK_PERMISSION_CONTAINER_SELECTOR).forEach(container => {
        if (isPermissionRequestContainer(container)) enqueueAskRequestContainer(container);
      });
      return;
    }
    const container = root.querySelector(ASK_PERMISSION_CONTAINER_SELECTOR);
    if (isPermissionRequestContainer(container)) enqueueAskRequestContainer(container);
  }

  function setupAskRequestRefinement() {
    if (document.body) {
      enqueueAskRequestRoots(document.body);
      askActive = !!document.querySelector(ASK_PERMISSION_CONTAINER_SELECTOR);
    }
    // PERF: this body-subtree observer fires for every token batch during
    // AI streaming. The old code ran `enqueueAskRequestRoots(m.target,
    // false)` — i.e. `closestPermissionRequestContainer()`, an ancestor walk to
    // <body> that is always null mid-stream — plus a `querySelector` for
    // EVERY such mutation, for a permission panel that is present a fraction of
    // the time. Gate it on actual panel presence (same idiom as the
    // diff-sidebar `liveDiffEditors` gate): a permission panel is a
    // self-contained subtree the host mounts/unmounts wholesale, never
    // nested under the streamed assistant prose. When no panel is
    // present and this mutation neither added nor removed one, skip with
    // zero `closest()`/`enqueue` work. Behaviour is unchanged whenever a
    // panel exists or appears/disappears.
    const mo = new MutationObserver(muts => {
      for (let i = 0; i < muts.length; i++) {
        const m = muts[i];
        if (m.type !== 'childList') continue;
        if (mutationInsideFocusedEditor(m)) continue;
        const structural = mutationTouchesAskSurface(m);
        if (structural) {
          askActive = !!document.querySelector(ASK_PERMISSION_CONTAINER_SELECTOR);
        }
        if (!askActive && !structural) continue;
        enqueueAskRequestRoots(m.target, false);
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) enqueueAskRequestRoots(node);
        }
      }
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ========== 8b. permission indicator softening ==========
  //
  // Class names for bypass and danger indicators vary across versions.
  // Text scanning provides a fallback by tagging small leaf nodes whose text
  // contains bypass or danger markers.
  const DANGER_TEXT_RE = /\b(bypass\s+permissions?|yolo\s*mode|dangerous(?:ly)?)\b/i;

  // Shared accent color for softened danger indicators.
  const CLAUDE_CORAL = '#d97757';
  const CLAUDE_CORAL_BG = 'rgba(217,119,87,0.10)';
  const CLAUDE_CORAL_BORDER = 'rgba(217,119,87,0.45)';

  function applyCoralStyle(el) {
    // Change only foreground-related properties. Some containers carry danger
    // classes on large surfaces and should keep their background fill.
    el.style.setProperty('color', CLAUDE_CORAL, 'important');
    el.style.setProperty('border-color', CLAUDE_CORAL_BORDER, 'important');
    el.style.setProperty('fill', CLAUDE_CORAL, 'important');
  }

  let _lastSoftenAt = 0;
  function softenDangerIndicators() {
    // Throttle to 1.2s.
    const now = performance.now();
    if (now - _lastSoftenAt < 1200) return;
    _lastSoftenAt = now;

    // 1) direct class-based matches
    const classSelectors = [
      '[class*="bypassPermission" i]',
      '[class*="bypass-permission" i]',
      '[class*="permissionMode" i]',
      '[class*="permission-mode" i]',
      '[class*="dangerMode" i]',
      '[class*="yoloMode" i]',
      '[class*="dangerous" i]',
    ];
    for (const sel of classSelectors) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (el.hasAttribute('data-claude-softened')) continue;
          el.setAttribute('data-claude-softened', '1');
          applyCoralStyle(el);
        }
      } catch { /* invalid selector on old chromium */ }
    }

    // 2) text-scan fallback, narrowly scoped to the chrome surfaces where
    //    bypass / danger indicators actually live (footer and header regions).
    //    The previous version scanned every `div,span,button,a,li` in the
    //    document, which was O(DOM) on every call.
    const scopes = [];
    for (const s of document.querySelectorAll(SEL.inputFooter)) scopes.push(s);
    for (const s of document.querySelectorAll(SEL.stickyMessage)) scopes.push(s);
    for (const scope of scopes) {
      const candidates = scope.querySelectorAll('div, span, button, a, li');
      for (const el of candidates) {
        if (el.hasAttribute('data-claude-softened')) continue;
        if (el.children.length > 5) continue;
        const text = (el.textContent || '').trim();
        if (text.length === 0 || text.length > 80) continue;
        if (DANGER_TEXT_RE.test(text)) {
          el.setAttribute('data-claude-softened', '1');
          applyCoralStyle(el);
        }
      }
    }
  }

  // ========== 9. bootstrap-owned surfaces ==========
  //
  // theme.css / warm-white CSS, VS Code app-var overrides, bodyBold, host_probe,
  // DOM freeze, and DOM-ready scheduling live in enhance_shared.js +
  // claude_code_enhance.js. Do not reintroduce those boot responsibilities here.

  // ========== 11. thinking ==========
  // Moved to enhance_thinking.js and loaded by the bootstrap scheduler.

  // ========== 12. init ==========


  // ============================================================
  // Diff side bars.
  // ============================================================
  //
  // Monaco's side-by-side diff layout becomes unusual once line numbers are
  // enabled: the original editor can collapse into a narrow line-number gutter
  // while the modified editor owns the visible inline code. Decorations placed
  // on either Monaco gutter then no longer line up with the rows the user is
  // reading. Draw the left rule ourselves instead: read the visible changed
  // rows from Monaco's overlay layer, project their client rects onto the diff root,
  // and place a 3px overlay at the far left.
  //
  // FRAGILITY NOTE: this uses Monaco's stable-ish DOM class names
  // (`monaco-diff-editor`, `.view-overlays`, `.line-insert/.line-delete`).
  // If Monaco changes those internals, the fallback is simply "no side rule";
  // syntax colours, line numbers, and diff bands still come from Monaco.
  const DIFF_EDITOR_SELECTOR =
    ':is([class*="diffEditorWrapper"], [class*="modalContent_"]) .monaco-diff-editor';

  let diffBarsRaf = 0;
  let diffInfoSeq = 0;
  let activeModalDiffInfoKey = '';
  const diffLineInfoByKey = new Map();
  const diffLineInfoByRequest = new Map();
  const diffLineInfoFileKey = new Map();
  let diffLineInfoListenerBound = false;

  // Track currently-mounted diff editors so we can do zero work when none
  // exist. Without this gate, every body-subtree childList mutation and every
  // capture-phase scroll event in the document — including the per-frame
  // auto-scroll of `messagesContainer` during streaming — triggered an rAF
  // followed by `document.querySelectorAll(DIFF_EDITOR_SELECTOR)`. Sessions
  // that never open an Edit/Write/MultiEdit tool paid that cost continuously.
  const liveDiffEditors = new Set();
  let diffSideBarsListenersBound = false;
  // Looser predicate than `DIFF_EDITOR_SELECTOR`: matches a wrapper even
  // before Monaco has mounted its `.monaco-diff-editor` inside, plus the
  // editor itself (covers the lazy-mount race). False positives — e.g. a
  // non-diff modal — only cost one extra `refreshLiveDiffEditors()` call,
  // which then finds nothing and leaves the set empty.
  const DIFF_TOUCH_SELECTOR =
    '[class*="diffEditorWrapper"], [class*="modalContent_"], .monaco-diff-editor';

  function nodeTouchesDiff(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.matches?.(DIFF_TOUCH_SELECTOR)) return true;
    return node.querySelector?.(DIFF_TOUCH_SELECTOR) != null;
  }

  function refreshLiveDiffEditors() {
    liveDiffEditors.clear();
    document.querySelectorAll(DIFF_EDITOR_SELECTOR).forEach(el => liveDiffEditors.add(el));
    syncDiffSideBarsListeners();
  }

  function syncDiffSideBarsListeners() {
    const want = liveDiffEditors.size > 0;
    if (want === diffSideBarsListenersBound) return;
    diffSideBarsListenersBound = want;
    if (want) {
      // Capture-phase: catches Monaco's internal scrollable as well as any
      // ancestor scroller that affects the diff's viewport position.
      document.addEventListener('scroll', scheduleDiffSideBars, true);
      window.addEventListener('resize', scheduleDiffSideBars);
    } else {
      document.removeEventListener('scroll', scheduleDiffSideBars, true);
      window.removeEventListener('resize', scheduleDiffSideBars);
    }
  }

  function scheduleDiffSideBars() {
    if (diffBarsRaf) return;
    if (liveDiffEditors.size === 0) return;
    diffBarsRaf = requestAnimationFrame(() => {
      diffBarsRaf = 0;
      syncAllDiffSideBars();
    });
  }

  function ensureDiffBarsLayer(diff) {
    let layer = diff.querySelector(':scope > [data-incipit-diff-bars]');
    if (!layer) {
      layer = document.createElement('div');
      layer.setAttribute('data-incipit-diff-bars', '');
      diff.appendChild(layer);
    }
    return layer;
  }

  function roundRectPx(value) {
    return Math.round(value * 10) / 10;
  }

  function diffPositiveLineNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  const diffPayloadCap = defineCapability({
    name: 'runtime.fiber.diffPayload',
    layer: 'fiber',
    presence: 'always',
    shapeValidate: value => value &&
      typeof value.oldText === 'string' &&
      typeof value.newText === 'string',
    probe(wrapper) {
      if (!wrapper) return { ok: false, value: null, reason: 'notMounted' };
      let f = reactFiberForElement(wrapper);
      if (!f) return { ok: false, value: null, reason: 'noFiber' };
      for (let i = 0; i < 30 && f; i++) {
        const p = f.memoizedProps;
        if (p && typeof p.original === 'string' && typeof p.modified === 'string') {
          return {
            ok: true,
            value: {
              filePath: typeof p.filePath === 'string' ? p.filePath : '',
              oldText: p.original,
              newText: p.modified,
              source: 'rendered',
            },
            reason: 'ok',
          };
        }
        f = f.return;
      }
      return { ok: false, value: null, reason: 'shapeMiss' };
    },
  });

  function readRenderedDiffPayload(wrapper) {
    const result = diffPayloadCap.read(wrapper);
    return result.ok ? result.value : null;
  }

  function firstEditPayload(input) {
    if (!input || typeof input !== 'object') return null;
    if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      return {
        oldText: typeof input.old_string === 'string' ? input.old_string : '',
        newText: typeof input.new_string === 'string' ? input.new_string : '',
      };
    }
    const edits = Array.isArray(input.edits) ? input.edits : [];
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      if (typeof edit.old_string === 'string' || typeof edit.new_string === 'string') {
        return {
          oldText: typeof edit.old_string === 'string' ? edit.old_string : '',
          newText: typeof edit.new_string === 'string' ? edit.new_string : '',
        };
      }
    }
    return null;
  }

  function writeDiffPayload(block) {
    const input = block && block.input;
    if (!input || typeof input !== 'object') return null;
    if (block.name !== 'Write') return null;
    if (typeof input.content !== 'string') return null;
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath) return null;
    return {
      filePath,
      oldText: '',
      newText: input.content,
      source: 'write-input',
    };
  }

  function editDiffPayload(block) {
    const input = block && block.input;
    if (!input || typeof input !== 'object') return null;
    if (block.name !== 'Edit' && block.name !== 'MultiEdit') return null;
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath) return null;
    // MultiEdit normally carries an `edits[]` list of independent replacements.
    // Rendering only the first hunk would be misleading, so keep that host path
    // until we build a multi-hunk island. The direct old/new shape is safe.
    if (block.name === 'MultiEdit' &&
        (typeof input.old_string !== 'string' && typeof input.new_string !== 'string')) {
      return null;
    }
    const edit = firstEditPayload(input);
    if (!edit) return null;
    return {
      filePath,
      oldText: edit.oldText,
      newText: edit.newText,
      source: block.name === 'MultiEdit' ? 'multiedit-input' : 'edit-input',
    };
  }

  function incipitDiffPayload(block) {
    return writeDiffPayload(block) || editDiffPayload(block);
  }

  function fallbackDiffPayload(block) {
    const input = block && block.input;
    if (!input || typeof input !== 'object') return null;
    const filePath = typeof input.file_path === 'string' ? input.file_path : '';
    if (!filePath) return null;
    const owned = incipitDiffPayload(block);
    if (owned) return owned;
    const edit = firstEditPayload(input);
    if (!edit) return null;
    return {
      filePath,
      oldText: edit.oldText,
      newText: edit.newText,
      source: 'tool-input',
    };
  }

  function diffLineInfoPayload(wrapper, block) {
    const rendered = readRenderedDiffPayload(wrapper);
    const fallback = fallbackDiffPayload(block);
    if (rendered && (rendered.oldText || rendered.newText)) {
      if (!rendered.filePath && fallback && fallback.filePath) rendered.filePath = fallback.filePath;
      if (rendered.filePath) return rendered;
    }
    return fallback;
  }

  function diffLineInfoFileKeyVariants(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return [];
    const slash = raw.replace(/\\/g, '/');
    const lowerSlash = slash.toLowerCase();
    const out = [raw, slash, lowerSlash];
    return out.filter((v, i) => v && out.indexOf(v) === i);
  }

  function rememberDiffLineInfoFileKey(filePath, key) {
    diffLineInfoFileKeyVariants(filePath).forEach(k => diffLineInfoFileKey.set(k, key));
  }

  function lookupDiffLineInfoFileKey(filePath) {
    for (const k of diffLineInfoFileKeyVariants(filePath)) {
      const key = diffLineInfoFileKey.get(k);
      if (key) return key;
    }
    return '';
  }

  function getIncipitVsCodeApi() {
    try {
      if (typeof globalThis.__incipitGetVsCodeApi === 'function') {
        return globalThis.__incipitGetVsCodeApi();
      }
      if (typeof acquireVsCodeApi === 'function') return acquireVsCodeApi();
    } catch (_) {}
    return null;
  }

  function hashStringForKey(value) {
    const s = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function diffLineInfoKey(payload) {
    if (!payload || !payload.filePath) return '';
    const oldText = typeof payload.oldText === 'string' ? payload.oldText : '';
    const newText = typeof payload.newText === 'string' ? payload.newText : '';
    return [
      payload.filePath,
      oldText.length,
      hashStringForKey(oldText),
      newText.length,
      hashStringForKey(newText),
    ].join('|');
  }

  function setupDiffLineInfoChannel() {
    if (diffLineInfoListenerBound) return;
    diffLineInfoListenerBound = true;
    window.addEventListener('message', evt => {
      const msg = evt && evt.data;
      if (!msg || msg.__incipit !== true || msg.type !== 'diff_line_info_response') return;
      const key = diffLineInfoByRequest.get(msg.requestId);
      if (!key) return;
      diffLineInfoByRequest.delete(msg.requestId);
      const current = diffLineInfoByKey.get(key) || {};
      const payload = msg.payload || {};
      diffLineInfoByKey.set(key, {
        ...current,
        status: payload && !payload.error ? 'ready' : 'error',
        oldStartLine: diffPositiveLineNumber(payload.oldStartLine),
        newStartLine: diffPositiveLineNumber(payload.newStartLine),
        startLine: diffPositiveLineNumber(payload.startLine),
      });
      scheduleDiffSideBars();
      try {
        document.querySelectorAll('[data-incipit-diff-island]').forEach(node => {
          if (node.dataset && node.dataset.incipitDiffLineInfoKey === key) {
            enqueueAffectedToolUses(node);
          }
        });
        if (pendingToolUseRoots.size) scheduleRescan();
      } catch (_) { /* best-effort line number refresh */ }
    });
  }

  function ensureDiffLineInfo(wrapper, block) {
    const payload = diffLineInfoPayload(wrapper, block);
    const key = diffLineInfoKey(payload);
    if (!key || !wrapper) return '';
    wrapper.dataset.incipitDiffLineInfoKey = key;
    const filePath = payload.filePath;
    if (filePath) rememberDiffLineInfoFileKey(filePath, key);

    const cached = diffLineInfoByKey.get(key);
    if (cached && cached.status) return key;

    const api = getIncipitVsCodeApi();
    if (!api || typeof api.postMessage !== 'function') {
      diffLineInfoByKey.set(key, { status: 'unavailable' });
      return key;
    }

    const requestId = 'diff-' + (++diffInfoSeq).toString(36);
    diffLineInfoByRequest.set(requestId, key);
    diffLineInfoByKey.set(key, { status: 'pending' });
    try {
      api.postMessage({
        __incipit: true,
        type: 'diff_line_info_request',
        requestId,
        filePath,
        oldText: typeof payload.oldText === 'string' ? payload.oldText : '',
        newText: typeof payload.newText === 'string' ? payload.newText : '',
      });
    } catch (_) {
      diffLineInfoByRequest.delete(requestId);
      diffLineInfoByKey.set(key, { status: 'error' });
    }
    return key;
  }

  function bindDiffModalKeyCapture(wrapper, key) {
    if (!wrapper || !key || wrapper.dataset.incipitDiffModalKeyBound === '1') return;
    wrapper.addEventListener('click', evt => {
      const target = evt.target;
      if (target && target.closest && target.closest('[class*="clickOverlay"]')) {
        activeModalDiffInfoKey = key;
        scheduleDiffSideBars();
      }
    }, true);
    wrapper.dataset.incipitDiffModalKeyBound = '1';
  }

  function diffLineInfoForEditor(diff) {
    const shell = diff.closest('[class*="diffEditorWrapper"], [class*="modalContent_"]');
    let key = shell && shell.dataset ? shell.dataset.incipitDiffLineInfoKey : '';
    if (!key && shell && shell.matches && shell.matches('[class*="modalContent_"]')) {
      key = activeModalDiffInfoKey;
      const title = shell.querySelector('[class*="modalTitle_"]');
      const filePath = title && title.textContent ? title.textContent.trim() : '';
      if (!key && filePath) key = lookupDiffLineInfoFileKey(filePath);
    }
    return key ? (diffLineInfoByKey.get(key) || null) : null;
  }

  function collectDiffBarSegments(diff) {
    const rows = diff.querySelectorAll(
      '.view-overlays .line-delete, .view-overlays .line-insert'
    );
    if (!rows.length) return [];

    const rootRect = diff.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return [];

    const segments = [];
    rows.forEach(row => {
      const type = row.classList.contains('line-insert') ? 'add'
        : row.classList.contains('line-delete') ? 'del'
        : '';
      if (!type) return;
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) return;
      const top = Math.max(0, rect.top - rootRect.top);
      const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top);
      if (bottom - top < 1) return;
      segments.push({
        type,
        top: roundRectPx(top),
        bottom: roundRectPx(bottom),
      });
    });

    segments.sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.type.localeCompare(b.type));

    const merged = [];
    for (const seg of segments) {
      const prev = merged[merged.length - 1];
      if (prev && prev.type === seg.type && seg.top <= prev.bottom + 1.5) {
        prev.bottom = Math.max(prev.bottom, seg.bottom);
      } else {
        merged.push({ ...seg });
      }
    }
    return merged;
  }

  function collectDiffLineNumbers(diff, info) {
    if (!info || info.status !== 'ready') return [];
    const oldStart = diffPositiveLineNumber(info.oldStartLine || info.startLine);
    const newStart = diffPositiveLineNumber(info.newStartLine || info.startLine);
    if (!oldStart && !newStart) return [];
    const rootRect = diff.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return [];

    const rows = [];
    const addRows = (selector, startLine, source) => {
      diff.querySelectorAll(selector).forEach(node => {
        const raw = (node.textContent || '').trim();
        const n = diffPositiveLineNumber(raw);
        if (!n) return;
        const rect = node.getBoundingClientRect();
        if (rect.height <= 0 || rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) return;
        rows.push({
          source,
          top: roundRectPx(Math.max(0, rect.top - rootRect.top)),
          height: roundRectPx(Math.min(rootRect.height, rect.bottom - rootRect.top) - Math.max(0, rect.top - rootRect.top)),
          line: startLine + n - 1,
        });
      });
    };

    addRows('.editor.original .line-numbers', oldStart || newStart, 'old');
    addRows('.editor.modified .line-numbers', newStart || oldStart, 'new');

    rows.sort((a, b) => a.top - b.top || (a.source === 'new' ? -1 : 1));
    const out = [];
    for (const row of rows) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.top - row.top) < 1.5) {
        // Prefer the modified-side number when both sides render a number at
        // the same visual row; the visible code is shifted into that column.
        if (row.source === 'new') {
          prev.line = row.line;
          prev.height = row.height || prev.height;
        }
        continue;
      }
      out.push(row);
    }
    return out;
  }

  function ensureDiffLineNumbersLayer(diff) {
    let layer = diff.querySelector(':scope > [data-incipit-diff-line-numbers]');
    if (!layer) {
      layer = document.createElement('div');
      layer.setAttribute('data-incipit-diff-line-numbers', '');
      diff.appendChild(layer);
    }
    return layer;
  }

  function syncOneDiffSideBars(diff) {
    const layer = ensureDiffBarsLayer(diff);
    const segments = collectDiffBarSegments(diff);
    const barsSignature = segments
      .map(seg => seg.type + ':' + seg.top + ':' + (seg.bottom - seg.top))
      .join('|');

    if (layer.dataset.incipitDiffBarsSig !== barsSignature) {
      layer.dataset.incipitDiffBarsSig = barsSignature;
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      for (const seg of segments) {
        const bar = document.createElement('div');
        bar.setAttribute('data-incipit-diff-bar', seg.type);
        bar.style.top = seg.top + 'px';
        bar.style.height = Math.max(2, seg.bottom - seg.top) + 'px';
        layer.appendChild(bar);
      }
    }

    const numsLayer = ensureDiffLineNumbersLayer(diff);
    const nums = collectDiffLineNumbers(diff, diffLineInfoForEditor(diff));
    for (const item of nums) {
      const mid = item.top + (item.height / 2);
      const hit = segments.find(seg => mid >= seg.top - 1 && mid <= seg.bottom + 1);
      item.kind = hit ? hit.type : '';
    }
    const numsSignature = nums.map(n => n.top + ':' + n.height + ':' + n.line + ':' + n.kind).join('|');
    if (numsLayer.dataset.incipitDiffLineNumsSig !== numsSignature) {
      numsLayer.dataset.incipitDiffLineNumsSig = numsSignature;
      while (numsLayer.firstChild) numsLayer.removeChild(numsLayer.firstChild);
      for (const item of nums) {
        const n = document.createElement('div');
        n.setAttribute('data-incipit-diff-line-number', item.kind || '');
        n.style.top = item.top + 'px';
        n.style.height = Math.max(1, item.height) + 'px';
        n.textContent = String(item.line);
        numsLayer.appendChild(n);
      }
    }
  }

  function syncAllDiffSideBars() {
    // Iterate the tracked set; lazily evict disconnected nodes (modal close,
    // toolUse remount). When the set drains we tear down the global scroll
    // and resize listeners so no further work is dispatched.
    for (const diff of Array.from(liveDiffEditors)) {
      if (!diff.isConnected) {
        liveDiffEditors.delete(diff);
        continue;
      }
      if (!diffIsNearViewport(diff)) continue;
      syncOneDiffSideBars(diff);
    }
    if (liveDiffEditors.size === 0) syncDiffSideBarsListeners();
  }

  function diffIsNearViewport(diff) {
    try {
      const rect = diff.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      if (rect.width <= 0 || rect.height <= 0 || vh <= 0) return false;
      const margin = Math.max(240, Math.min(800, vh));
      return rect.bottom >= -margin && rect.top <= vh + margin;
    } catch (_) {
      return true;
    }
  }

  function setupDiffSideBars() {
    setupDiffLineInfoChannel();
    refreshLiveDiffEditors();
    scheduleDiffSideBars();

    // Body-subtree childList still has to be observed so that we notice when
    // a diff editor mounts (Edit/Write tool call streams in) or unmounts
    // (modal close, fold collapse). Critically, we now FILTER the mutations:
    // schedule + refresh only when the mutation actually touches a diff
    // wrapper / `.monaco-diff-editor`. Streaming text mutations no longer
    // trigger an rAF + global QSA on every frame.
    const mo = new MutationObserver(muts => {
      let touched = false;
      for (let i = 0; i < muts.length && !touched; i++) {
        const m = muts[i];
        if (m.type !== 'childList') continue;
        if (mutationInsideFocusedEditor(m)) continue;
        for (let j = 0; j < m.addedNodes.length; j++) {
          if (nodeTouchesDiff(m.addedNodes[j])) { touched = true; break; }
        }
        if (touched) break;
        for (let j = 0; j < m.removedNodes.length; j++) {
          if (nodeTouchesDiff(m.removedNodes[j])) { touched = true; break; }
        }
      }
      if (touched) {
        refreshLiveDiffEditors();
        scheduleDiffSideBars();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // Tool-use fold.
  // ============================================================
  //
  // Each `[class*="toolUse_"]` element holds one tool-call block. Claude
  // Code renders these fully expanded by default — for a long conversation
  // with many Edits, the diff editors eat the whole transcript viewport.
  //
  // We pierce React fiber to read the underlying `tool_use` block:
  //   { type: 'tool_use', name: 'Edit', input: { old_string, new_string, ... } }
  // and compute precise `+added / -removed` line counts via line-level LCS.
  // Then we:
  //   1. inject a `<span data-incipit-tool-stats>+N −M ▸</span>` at the end
  //      of the tool summary row (stats only for Edit/MultiEdit/Write),
  //   2. default-collapse the body via `data-incipit-tool-collapsed="true"`,
  //   3. hide the host `secondaryLine` ("Modified" / "Added 1 line") only
  //      when we provided our own stats — non-Edit/Write tools keep their
  //      host-provided fingerprint because we have nothing better to say.
  //
  // The fiber walk is bounded (10 levels up) and the LCS DP is capped at
  // 500k cell-products (roughly 700×700 lines) before falling back to a
  // length-delta approximation, so pathological Edit sizes cannot stall
  // the render.
  //
  // FRAGILITY NOTE — this is the only place in the project that reads
  // React's internal bookkeeping (private fiber key / `memoizedProps`). Every
  // other module (host_probe, math gate, thinking, badge, input avoidance)
  // stays on CSS module prefixes + DOM structure, which survives Claude
  // Code's minor version bumps. Fiber pierce does not have that guarantee:
  // a React major upgrade could rename the DOM key (historical precedent:
  // 16→17 private instance/fiber key), and a bundler /
  // component refactor inside Claude Code could reshape `memoizedProps`
  // into something `readToolUseBlock` no longer recognises. We mitigate
  // with a dual-shape unwrap (accepts both `p.content.type` and
  // `p.content.content.type`) and a null-early-return, so the failure mode
  // is "tool-fold silently disabled, host renders natively" rather than a
  // half-broken UI — but if this function ever stops decorating anything,
  // the first suspect is a fiber shape drift, not a CSS selector miss.
  function setupToolFold() {
    // Animated expand / collapse for the tool body. Drives the transition
    // by writing `inline max-height` from `scrollHeight` so the curve runs
    // the full natural distance — a fixed CSS `max-height` cap would let
    // short bodies feel instantaneous and clip long ones. The resting CSS
    // rule (`max-height: 0` while collapsed) takes over after the
    // `transitionend` clears the inline value.
    //
    // Constant-speed timing: instead of a fixed duration, duration scales
    // with the distance traveled (px / FOLD_SPEED_PX_PER_S), clamped into
    // [FOLD_MIN_DUR_MS, FOLD_MAX_DUR_MS]. This gives every fold a uniform
    // visual velocity — short Read-summary bodies don't drag, long Edit
    // diffs don't fly past the eye in 220 ms.
    const FOLD_SPEED_PX_PER_S = 900;
    const FOLD_MIN_DUR_MS = 160;
    const FOLD_MAX_DUR_MS = 950;
    function foldDuration(distance) {
      const ms = (Math.abs(distance) / FOLD_SPEED_PX_PER_S) * 1000;
      return Math.max(FOLD_MIN_DUR_MS, Math.min(FOLD_MAX_DUR_MS, ms));
    }

    function cancelFoldAnimation(target) {
      if (!target) return;
      if (target.__incipitFoldTimer) {
        clearTimeout(target.__incipitFoldTimer);
        target.__incipitFoldTimer = 0;
      }
      if (target.__incipitFoldRaf) {
        cancelAnimationFrame(target.__incipitFoldRaf);
        target.__incipitFoldRaf = 0;
      }
      if (target.__incipitFoldEnd) {
        target.removeEventListener('transitionend', target.__incipitFoldEnd);
        target.__incipitFoldEnd = null;
      }
    }

    function clearFoldInline(target) {
      cancelFoldAnimation(target);
      target.style.maxHeight = '';
      target.style.transitionDuration = '';
    }

    function armFoldCleanup(target, durationMs) {
      function onEnd(e) {
        if (e.target !== target || e.propertyName !== 'max-height') return;
        cleanup();
      }
      function cleanup() {
        if (target.__incipitFoldEnd !== onEnd) return;
        if (target.__incipitFoldTimer) {
          clearTimeout(target.__incipitFoldTimer);
          target.__incipitFoldTimer = 0;
        }
        target.removeEventListener('transitionend', onEnd);
        target.__incipitFoldEnd = null;
        target.style.maxHeight = '';
        target.style.transitionDuration = '';
      }

      target.__incipitFoldEnd = onEnd;
      target.addEventListener('transitionend', onEnd);
      // `transitionend` is not guaranteed: target height can measure as 0
      // while Monaco is still laying out, the element can detach mid-flight,
      // or the browser can coalesce the start/end values. The timeout makes
      // the failure posture "fail open" instead of leaving max-height:0.
      target.__incipitFoldTimer = setTimeout(cleanup, durationMs + 120);
    }

    function foldTargetHeight(target) {
      const rectHeight = target.getBoundingClientRect ? target.getBoundingClientRect().height : 0;
      return Math.max(target.scrollHeight || 0, Math.ceil(rectHeight || 0));
    }

    function scheduleFoldLayoutRefresh(targets) {
      const needsRefresh = targets.some(t => (
        t && t.querySelector &&
        t.querySelector('[class*="diffEditorContainer"], .monaco-diff-editor, .monaco-editor')
      ));
      if (!needsRefresh) return;

      // Monaco can be created while the host body was display:none (the host
      // hides tool bodies below 500px). Once incipit reveals the body, nudge
      // Monaco's automaticLayout / ResizeObserver path over two frames.
      requestAnimationFrame(() => {
        try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        requestAnimationFrame(() => {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        });
      });
    }

    function animateExpandTargets(el, targets) {
      targets = targets.filter(Boolean);
      if (!targets.length) {
        el.dataset.incipitToolCollapsed = 'false';
        return;
      }

      // Pin every target at 0 first, then flip the attr so CSS switches the
      // row label/chevron state before measuring the open layout.
      targets.forEach(t => {
        cancelFoldAnimation(t);
        t.style.transitionDuration = '0ms';
        t.style.maxHeight = '0px';
      });
      el.dataset.incipitToolCollapsed = 'false';
      targets.forEach(t => { void t.offsetHeight; });
      scheduleFoldLayoutRefresh(targets);

      targets.forEach(t => {
        const target = foldTargetHeight(t);
        if (target <= 0) {
          // Monaco diff editors can finish their internal layout only after
          // the body becomes visible. If the first measurement is 0, clearing
          // the inline clamp is safer than animating 0 -> 0 and trapping the
          // eventual editor behind max-height:0.
          clearFoldInline(t);
          return;
        }
        const duration = foldDuration(target);
        t.style.transitionDuration = duration + 'ms';
        t.style.maxHeight = target + 'px';
        armFoldCleanup(t, duration);
      });
    }

    function animateCollapseTargets(el, targets) {
      targets = targets.filter(Boolean);
      if (!targets.length) {
        el.dataset.incipitToolCollapsed = 'true';
        return;
      }

      const starts = targets.map(foldTargetHeight);
      targets.forEach((t, i) => {
        cancelFoldAnimation(t);
        const start = starts[i];
        if (start > 0) {
          t.style.transitionDuration = foldDuration(start) + 'ms';
          t.style.maxHeight = start + 'px';
        }
      });
      el.dataset.incipitToolCollapsed = 'true';

      targets.forEach((t, i) => {
        const start = starts[i];
        if (start <= 0) {
          clearFoldInline(t);
          return;
        }
        const duration = foldDuration(start);
        void t.offsetHeight;
        t.style.maxHeight = '0px';
        armFoldCleanup(t, duration);
      });
    }

    function animateExpandBody(el, body) {
      animateExpandTargets(el, [body]);
    }

    function animateCollapseBody(el, body) {
      animateCollapseTargets(el, [body]);
    }

    // First-time collapse without the flash. CSS gives toolBody (and
    // grep expansion) a default `max-height` transition so click
    // toggles animate. But the very first time we set
    // `data-incipit-tool-collapsed='true'` (right after stream finishes
    // filling the body), the body's resting max-height is `none` and
    // Chromium does interpolate `none → 0` by treating `none` as the
    // current scrollHeight — visible as the tool flashing fully open
    // and then snapping shut. Inline `transition: none` + force-reflow
    // + rAF restore makes the initial snap instant, leaving the click
    // animation rule untouched. Older comment claimed Chromium does
    // not interpolate this case; that turned out to be wrong in
    // practice.
    function snapInitialCollapse(el) {
      const targets = [];
      const tb = el.querySelector('[class*="toolBody_"]');
      if (tb) targets.push(tb);
      const exp = el.querySelector('[data-incipit-tool-grep-expansion]');
      if (exp) targets.push(exp);
      const prevs = targets.map(t => t.style.transition);
      targets.forEach(t => {
        clearFoldInline(t);
        t.style.transition = 'none';
      });
      el.dataset.incipitToolCollapsed = 'true';
      // Force a synchronous layout pass so the no-transition collapse
      // commits before we restore the CSS-driven transition next frame.
      if (targets.length) void targets[0].offsetHeight;
      requestAnimationFrame(() => {
        targets.forEach((t, i) => { t.style.transition = prevs[i] || ''; });
      });
    }

    // Reads the tool_result block paired with a given tool_use, by
    // pulling it off Claude Code's Preact Signal. Host wraps each
    // tool-call entry in a synthetic prop object whose two relevant
    // fields are:
    //   memoizedProps.content.content           — the tool_use block
    //   memoizedProps.content.toolResultSignal  — Preact Signal whose
    //                                             .peek() returns the
    //                                             tool_result block
    // The signal lives on the SAME fiber that renders the tool_use, so
    // we walk fiber.return up until we hit a fiber whose
    // memoizedProps.content has a toolResultSignal field, then peek it.
    //
    // Why .peek() not .value: .value subscribes the current React
    // render scope to the signal (Preact Signals integration). We're
    // reading from event handlers and decorate passes, NOT from a
    // render — subscribing here would either no-op (no scope) or in
    // worst case wire up a dangling subscription. .peek() reads the
    // current value with zero side effects.
    //
    // Fragility: depends on (a) fiber prop shape (`content.content` +
    // `content.toolResultSignal`), (b) Preact Signals API (.peek). If
    // host migrates off Preact Signals, swap to whatever new mechanism
    // they use — the fiber walk + outer prop name `content` are the
    // stable parts. See `__incipitDumpFiber` for diagnostic dumping.
    const _toolResultDiagSeen = new Set();
    const toolUseBlockCap = defineCapability({
      name: 'runtime.fiber.toolUseBlock',
      layer: 'fiber',
      presence: 'afterSeen',
      shapeValidate: v => v && v.block && v.block.type === 'tool_use',
      probe(el) {
        if (!el) return { ok: false, value: null, reason: 'notMounted' };
        const fk = reactFiberKeyForElement(el);
        if (!fk) return { ok: false, value: null, reason: 'noFiber' };
        let f = el[fk];
        for (let i = 0; i < 10 && f; i++) {
          const p = f.memoizedProps;
          if (p && p.content) {
            const outer = p.content;
            if (outer.type === 'tool_use') {
              return { ok: true, value: { block: outer, status: p.status }, reason: 'ok' };
            }
            if (outer.content && outer.content.type === 'tool_use') {
              return { ok: true, value: { block: outer.content, status: p.status }, reason: 'ok' };
            }
          }
          f = f.return;
        }
        return { ok: false, value: null, reason: 'shapeMiss' };
      },
    });

    // Manual fiber-tree DFS dumper. Call from webview Devtools console:
    //   __incipitDumpFiber()              — uses last [data-incipit-tool-use]
    //   __incipitDumpFiber(domEl)         — uses given element
    // Walks fiber.return up to the root, then DFS down via child/sibling
    // (no `return` traversal — that would create cycles). Records every
    // memoizedProps key whose value either *is* a content block or is an
    // array containing content blocks, regardless of the key name. The
    // goal is to find where tool_result lives — fiber.return walk from
    // toolUse missed it, so the value must be reachable only from the
    // root downward (e.g. a ConversationView store-driven prop, or a
    // sibling subtree we never visited).
    window.__incipitDumpFiber = function (target) {
      let el = target;
      if (!el) {
        const all = document.querySelectorAll('[data-incipit-tool-use]');
        el = all[all.length - 1];
        if (!el) { console.warn('[incipit dump] no [data-incipit-tool-use] found'); return; }
      }
      const fk = reactFiberKeyForElement(el);
      if (!fk) { console.warn('[incipit dump] no React fiber key on element'); return; }

      let f = el[fk];
      let upDepth = 0;
      while (f.return) { f = f.return; upDepth++; }
      console.log('[incipit dump] walked up', upDepth, 'fibers to root');

      const KNOWN_BLOCK_TYPES = new Set([
        'tool_use', 'tool_result', 'text', 'image',
        'thinking', 'redacted_thinking', 'document', 'server_tool_use', 'web_search_tool_result'
      ]);
      function fiberName(fb) {
        if (!fb) return '?';
        const t = fb.type;
        if (t == null) return 'null';
        if (typeof t === 'string') return t;
        if (typeof t === 'function') return t.displayName || t.name || 'Fn';
        if (typeof t === 'object') {
          return t.displayName ||
                 (t.render && (t.render.displayName || t.render.name)) ||
                 (t.type && (t.type.displayName || t.type.name)) ||
                 'Obj';
        }
        return String(t);
      }
      function looksLikeBlock(v) {
        return v && typeof v === 'object' &&
               typeof v.type === 'string' &&
               KNOWN_BLOCK_TYPES.has(v.type);
      }
      function describeBlock(b) {
        const id = b.id || b.tool_use_id || '';
        let contentKind = null;
        if (Array.isArray(b.content)) contentKind = 'arr[' + b.content.length + ']';
        else if (typeof b.content === 'string') contentKind = 'str[' + b.content.length + ']';
        else if (b.content != null) contentKind = typeof b.content;
        return {
          type: b.type,
          id: id ? id.slice(-8) : undefined,
          name: b.name,
          contentKind,
        };
      }

      const findings = [];
      const visited = new WeakSet();
      function scan(fb, depth) {
        if (!fb || visited.has(fb)) return;
        visited.add(fb);
        const p = fb.memoizedProps;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
          for (const k of Object.keys(p)) {
            const v = p[k];
            if (Array.isArray(v) && v.length && v.some(looksLikeBlock)) {
              findings.push({
                depth,
                fiber: fiberName(fb),
                propKey: k,
                arrLen: v.length,
                blocks: v.filter(looksLikeBlock).map(describeBlock),
              });
            } else if (looksLikeBlock(v)) {
              findings.push({
                depth,
                fiber: fiberName(fb),
                propKey: k,
                block: describeBlock(v),
              });
            }
          }
        }
        scan(fb.child, depth + 1);
        scan(fb.sibling, depth);
      }
      scan(f, 0);

      const toolResultHits = findings.filter(x =>
        (x.blocks && x.blocks.some(b => b.type === 'tool_result')) ||
        (x.block && x.block.type === 'tool_result')
      );
      const toolUseHits = findings.filter(x =>
        (x.blocks && x.blocks.some(b => b.type === 'tool_use')) ||
        (x.block && x.block.type === 'tool_use')
      );

      console.log('[incipit dump] total findings:', findings.length);
      console.log('[incipit dump] tool_result hits:', toolResultHits);
      console.log('[incipit dump] tool_use hits:', toolUseHits);
      console.log('[incipit dump] all findings:', findings);
      window.__incipitFiberRoot = f;
      window.__incipitFiberFindings = findings;
      console.log('[incipit dump] stashed: window.__incipitFiberRoot, window.__incipitFiberFindings');
      return { root: f, findings, toolResultHits, toolUseHits };
    };

    const toolResultSignalCap = defineCapability({
      name: 'runtime.fiber.toolResultSignal',
      layer: 'fiber',
      presence: 'always',
      shapeValidate: value => value && value.type === 'tool_result',
      probe(ctx) {
        const useBlock = ctx && ctx.useBlock;
        const el = ctx && ctx.el;
        if (!useBlock || !useBlock.id) {
          return { ok: false, value: null, reason: 'notApplicable' };
        }
        const targetId = useBlock.id;
        if (!el) return { ok: false, value: null, reason: 'notMounted', detail: { targetId: targetId.slice(-8) } };

        const fk = reactFiberKeyForElement(el);
        if (!fk) return { ok: false, value: null, reason: 'noFiber', detail: { targetId: targetId.slice(-8) } };

        let f = el[fk];
        for (let i = 0; i < 30 && f; i++) {
          const c = f.memoizedProps && f.memoizedProps.content;
          if (c && typeof c === 'object' && c.toolResultSignal) {
            try {
              const sig = c.toolResultSignal;
              const tr = typeof sig.peek === 'function' ? sig.peek() : sig.value;
              if (tr && tr.type === 'tool_result' && tr.tool_use_id === targetId) {
                return { ok: true, value: tr, reason: 'ok', detail: { targetId: targetId.slice(-8) } };
              }
            } catch (error) {
              return {
                ok: false,
                value: null,
                reason: 'error',
                detail: { targetId: targetId.slice(-8), message: error && error.message },
              };
            }
            break; // found the wrapper but couldn't read — don't keep walking
          }
          f = f.return;
        }
        return { ok: false, value: null, reason: 'shapeMiss', detail: { targetId: targetId.slice(-8) } };
      },
    });

    function readToolResult(useBlock, el) {
      const result = toolResultSignalCap.read({ useBlock, el });
      if (result.ok) return result.value;

      const targetId = useBlock && useBlock.id;
      if (targetId && result.reason === 'shapeMiss' && !_toolResultDiagSeen.has(targetId)) {
        _toolResultDiagSeen.add(targetId);
        console.warn('[incipit] toolResultSignal not found for', targetId.slice(-8),
                     '— host fiber prop shape may have changed; run __incipitDumpFiber()');
      }
      return null;
    }

    function extractResultText(result) {
      if (!result || !result.content) return '';
      if (typeof result.content === 'string') return result.content;
      if (Array.isArray(result.content)) {
        return result.content
          .filter(c => c && c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text)
          .join('\n');
      }
      return '';
    }

    function readToolUseBlock(el) {
      const result = toolUseBlockCap.read(el);
      return result.ok ? result.value : null;
    }

    function lineDiffStats(oldText, newText) {
      const a = String(oldText == null ? '' : oldText).split('\n');
      const b = String(newText == null ? '' : newText).split('\n');
      const m = a.length, n = b.length;
      if (m === 0 && n === 0) return { added: 0, removed: 0 };
      if (m * n > 500000) {
        return {
          added: Math.max(0, n - m),
          removed: Math.max(0, m - n),
        };
      }
      const prev = new Array(n + 1).fill(0);
      const curr = new Array(n + 1).fill(0);
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1] + 1;
          else curr[j] = curr[j - 1] > prev[j] ? curr[j - 1] : prev[j];
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
      }
      const lcs = prev[n];
      return { added: n - lcs, removed: m - lcs };
    }

    function computeStats(block) {
      if (!block || !block.input) return null;
      const name = block.name;
      const input = block.input;
      if (name === 'Edit' || name === 'MultiEdit') {
        if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
          return lineDiffStats(input.old_string, input.new_string);
        }
      } else if (name === 'Write') {
        if (typeof input.content === 'string') {
          const lines = input.content === '' ? 0 : input.content.split('\n').length;
          return { added: lines, removed: 0 };
        }
      }
      return null;
    }

    // Per-tool label shown in expanded state in place of the host
    // secondaryLine / our fallback fingerprint. Edit / MultiEdit / Write
    // own the row with `+N -M`, so they never get a label.
    function pickLabelFor(name) {
      switch (name) {
        case 'Edit': case 'MultiEdit': case 'Write': return null;
        case 'Bash': case 'PowerShell':              return 'command';
        case 'Grep': case 'Glob':                    return 'pattern';
        case 'WebSearch': case 'ToolSearch':         return 'query';
        case 'WebFetch':                             return 'url';
        case 'Task': case 'Agent':                   return 'description';
        case 'TodoWrite':                            return 'todos';
        case 'LSP':                                  return 'operation';
        default:
          return (typeof name === 'string' && name.startsWith('mcp__')) ? 'args' : null;
      }
    }

    // Fallback fingerprint for tools whose host secondaryLine is empty
    // (PowerShell / LSP / many MCP tools). Only consulted when host
    // secondaryLine has no text — never overwrites the host's own.
    function pickFallbackFingerprint(name, input) {
      if (!input || typeof input !== 'object') return null;
      const s = (k) => typeof input[k] === 'string' && input[k] ? input[k] : null;
      switch (name) {
        case 'Bash': case 'PowerShell':      return s('command');
        case 'Grep': case 'Glob':            return s('pattern');
        case 'WebSearch': case 'ToolSearch': return s('query');
        case 'WebFetch':                     return s('url');
        case 'Task': case 'Agent':           return s('description');
        case 'TodoWrite': {
          const todos = input.todos;
          if (Array.isArray(todos) && todos.length) {
            const first = todos[0];
            const head = first && typeof first.content === 'string' ? first.content : (todos.length + ' items');
            return todos.length > 1 ? head + ' (+' + (todos.length - 1) + ' more)' : head;
          }
          return null;
        }
        case 'LSP': {
          const op = s('operation') || '';
          const fp = s('filePath') || '';
          const ln = typeof input.line === 'number' ? input.line : null;
          const base = fp ? fp.split(/[\\/]/).pop() : '';
          let out = op;
          if (base) out += (out ? ' ' : '') + base;
          if (ln != null) out += ':' + ln;
          return out || null;
        }
        default: {
          for (const k of Object.keys(input)) {
            const v = input[k];
            if (typeof v === 'string' && v) return v;
          }
          return null;
        }
      }
    }

    // Grep-only single-line layout helper. Mirrors the host's standalone
    // `secondaryLine_*` row ("N lines of output") into a span injected at
    // the end of titleWrap, so the collapsed Grep summary reads as one
    // line instead of two. The CSS rules behind `data-incipit-tool-grep`
    // hide the host secondaryLine while collapsed and reveal it again
    // when expanded — host gets its native two-row layout back at that
    // point. Decoupling: every selector keys off our own data-attrs, no
    // host class enters the cascade.
    // OUT-row truncation thresholds. Grep can return hundreds of matched
    // lines — letting them all flow into a single tool entry hijacks the
    // viewport (violates "reading first, tool second"). Grep results are
    // especially scannable and repetitive, so keep the inline allowance
    // tighter than generic tool output: first 5 lines (or up to 1200 chars
    // at last full-line boundary), with full output only at ≤ 7 lines and
    // ≤ 1200 chars.
    const GREP_OUT_KEEP_LINES = 5;
    const GREP_OUT_FULL_BELOW_LINES = 7;
    const GREP_OUT_KEEP_CHARS = 1200;

    function applyGrepOutTruncation(outContent, fullText) {
      const lines = fullText.split('\n');
      const tooManyLines = lines.length > GREP_OUT_FULL_BELOW_LINES;
      const tooManyChars = fullText.length > GREP_OUT_KEEP_CHARS;
      const needsTruncation = tooManyLines || tooManyChars;

      if (!needsTruncation) {
        // Short content — display full, no toggle.
        if (outContent.firstChild?.nodeType !== 3 ||
            outContent.firstChild.nodeValue !== fullText ||
            outContent.childNodes.length !== 1) {
          while (outContent.firstChild) outContent.removeChild(outContent.firstChild);
          outContent.appendChild(document.createTextNode(fullText));
        }
        return;
      }

      // Trim by line count first, then clip to char budget at the last
      // full-line boundary so we never cut mid-line (would mislead).
      let kept = lines.slice(0, GREP_OUT_KEEP_LINES).join('\n');
      if (kept.length > GREP_OUT_KEEP_CHARS) {
        const clipped = kept.slice(0, GREP_OUT_KEEP_CHARS);
        const lastNL = clipped.lastIndexOf('\n');
        kept = lastNL > 0 ? clipped.slice(0, lastNL) : clipped;
      }
      const keptLineCount = kept.split('\n').length;
      const hidden = lines.length - keptLineCount;
      const moreText = CFG.language === 'zh'
        ? (hidden > 0 ? ('+ 还有 ' + hidden + ' 行') : '+ 更多文本')
        : (hidden > 0 ? ('+ ' + hidden + ' more line' + (hidden === 1 ? '' : 's')) : '+ more text');
      const lessText = CFG.language === 'zh' ? '− 收起' : '− show less';

      // Toggle state: button sits at the visual tail of the OUT content
      // (after `kept` when collapsed, after `fullText` when expanded), so
      // a user reading to the bottom of the long output finds the
      // collapse affordance at the natural end-of-read point.
      const expanded = outContent.dataset.userExpanded === '1';
      const visibleText = expanded ? fullText : kept;
      const btnText = expanded ? lessText : moreText;

      // Idempotent: skip rebuild if structure already matches.
      const first = outContent.firstChild;
      const last = outContent.lastChild;
      if (first && first.nodeType === 3 && first.nodeValue === visibleText &&
          last && last.nodeType === 1 &&
          last.getAttribute && last.getAttribute('data-incipit-tool-grep-more') !== null &&
          last.textContent === btnText) {
        return;
      }

      while (outContent.firstChild) outContent.removeChild(outContent.firstChild);
      outContent.appendChild(document.createTextNode(visibleText));
      const btn = document.createElement('span');
      btn.setAttribute('data-incipit-tool-grep-more', '');
      btn.textContent = btnText;
      btn.addEventListener('click', evt => {
        // Don't fold the parent grep entry on click of this toggle.
        evt.stopPropagation();
        const wasExpanded = outContent.dataset.userExpanded === '1';
        if (wasExpanded) {
          // Collapsing — preserve the button's viewport anchor. After
          // collapse the OUT body shrinks by hundreds of pixels; if we
          // do nothing, the user's focus point falls into whatever
          // content happens to be sitting at that absolute Y now (next
          // tool call, next message), which is disorienting. Capture
          // the button's clientRect before mutation, run the rebuild,
          // then scroll the nearest overflow ancestor by the delta so
          // the rebuilt button lands at the same viewport Y.
          const beforeTop = btn.getBoundingClientRect().top;
          outContent.dataset.userExpanded = '0';
          applyGrepOutTruncation(outContent, fullText);
          const newBtn = outContent.querySelector('[data-incipit-tool-grep-more]');
          if (newBtn) {
            const afterTop = newBtn.getBoundingClientRect().top;
            const delta = afterTop - beforeTop;
            if (delta !== 0) {
              const scroller = findScrollAncestor(outContent);
              if (scroller === window) window.scrollBy(0, delta);
              else scroller.scrollTop += delta;
            }
          }
        } else {
          // Expanding — leave viewport alone. The button is already in
          // view (user just clicked it); content grows downward from a
          // stable origin, which matches the user's mental model.
          outContent.dataset.userExpanded = '1';
          applyGrepOutTruncation(outContent, fullText);
        }
      });
      outContent.appendChild(btn);
    }

    // ----------------------------------------------------------------
    // Generic IN/OUT row truncation for the host's `toolBodyGrid`
    // template (Bash, PowerShell, LSP, MCP, Read, TodoWrite, Write,
    // NotebookEdit, WebSearch, etc. — every tool whose body is rendered
    // through the shared grid). Edit/MultiEdit diff blocks use
    // diffEditorWrapper, not toolBodyGrid, so they bypass this code
    // path. Grep takes its own route through `applyGrepOutTruncation`
    // because it pierces the Preact result signal and replaces text
    // wholesale; here we cooperate with React-owned <pre> nodes by
    // CSS-clipping them in place and parking a sibling toggle button
    // outside the clip box.
    //
    // Generic tool output uses the middle allowance: full at ≤ 9 logical
    // lines and ≤ 1800 chars, otherwise clip to ~7 visual lines. Bash /
    // PowerShell input commands get a tighter command profile: full at ≤ 4
    // lines and ≤ 900 chars, otherwise clip to ~3 visual lines. Diff tools
    // and Grep have their own previews.
    //
    // CSS clip vs text-replace: text-replace would lose syntax
    // highlighting that hljs may apply on the host <pre>, and would
    // race React's reconcile (host owns this DOM, we don't). CSS clip
    // leaves DOM untouched; we only set/clear our own data-attr and
    // add a sibling button. Idempotent across re-decorates.
    // ----------------------------------------------------------------
    const TOOL_ROW_PREVIEW = {
      generic: { keepLines: 7, fullBelowLines: 9, keepChars: 1800 },
      command: { keepLines: 3, fullBelowLines: 4, keepChars: 900 },
    };

    function applyToolBodyTruncation(grid, toolName) {
      const rows = grid.querySelectorAll('[class*="toolBodyRow"]');
      for (const row of rows) {
        const content = row.querySelector('[class*="toolBodyRowContent"]');
        if (!content) continue;
        applyToolRowTruncation(content, toolRowPreviewProfile(row, toolName));
      }
    }

    function toolRowPreviewProfile(row, toolName) {
      const label = (row.querySelector('[class*="toolBodyRowLabel"]')?.textContent || '')
        .trim()
        .toLowerCase();
      const isCommandInput =
        (toolName === 'Bash' || toolName === 'PowerShell') &&
        (label === 'in' || label === 'input' || label === 'command');
      return isCommandInput ? TOOL_ROW_PREVIEW.command : TOOL_ROW_PREVIEW.generic;
    }

    function toolMoreText(hiddenLines) {
      return hiddenLines > 0
        ? '+ ' + hiddenLines + ' more line' + (hiddenLines === 1 ? '' : 's')
        : '+ more text';
    }

    function applyToolRowTruncation(content, profile) {
      profile = profile || TOOL_ROW_PREVIEW.generic;
      // Pick the inner element to clip. OUT cells wrap their pre in a
      // `toolResult_*` div; IN cells expose <pre> directly.
      const clipTarget = content.querySelector('[class*="toolResult_"]') ||
                         content.querySelector('pre');
      if (!clipTarget) return;

      const fullText = clipTarget.textContent || '';
      const lines = fullText.split('\n');
      const tooLong = lines.length > profile.fullBelowLines ||
                      fullText.length > profile.keepChars;

      // Short content — clear any prior truncation state, drop button.
      if (!tooLong) {
        if (clipTarget.getAttribute('data-incipit-tool-out-clipped') !== null) {
          clipTarget.removeAttribute('data-incipit-tool-out-clipped');
        }
        clipTarget.style.removeProperty('--incipit-tool-out-preview-max-height');
        const oldBtn = content.querySelector(':scope > [data-incipit-tool-out-more]');
        if (oldBtn) oldBtn.remove();
        if (content.dataset.userExpanded) delete content.dataset.userExpanded;
        return;
      }

      // Long content — apply / lift clip based on user-expanded state.
      const expanded = content.dataset.userExpanded === '1';
      if (expanded) {
        if (clipTarget.getAttribute('data-incipit-tool-out-clipped') !== null) {
          clipTarget.removeAttribute('data-incipit-tool-out-clipped');
        }
      } else {
        if (clipTarget.getAttribute('data-incipit-tool-out-clipped') !== '1') {
          clipTarget.setAttribute('data-incipit-tool-out-clipped', '1');
        }
        clipTarget.style.setProperty(
          '--incipit-tool-out-preview-max-height',
          (profile.keepLines * 1.5) + 'em'
        );
      }

      // Toggle button. Lives as the LAST child of the content cell so
      // overflow:hidden on clipTarget never swallows it.
      const hidden = Math.max(lines.length - profile.keepLines, 0);
      const moreText = toolMoreText(hidden);
      const lessText = '− show less'; // U+2212 minus, visually paired with '+'
      const btnText = expanded ? lessText : moreText;

      let btn = content.querySelector(':scope > [data-incipit-tool-out-more]');
      if (!btn) {
        btn = document.createElement('span');
        btn.setAttribute('data-incipit-tool-out-more', '');
        btn.addEventListener('click', evt => {
          // Don't fold the parent tool entry on click of this toggle.
          evt.stopPropagation();
          const wasExpanded = content.dataset.userExpanded === '1';
          if (wasExpanded) {
            // Collapsing — preserve viewport anchor like the Grep path.
            // Without this, the user's focus point falls into whatever
            // tool/message happens to be at that absolute Y after the
            // OUT body shrinks by hundreds of pixels.
            const beforeTop = btn.getBoundingClientRect().top;
            content.dataset.userExpanded = '0';
            applyToolRowTruncation(content, profile);
            const newBtn = content.querySelector(':scope > [data-incipit-tool-out-more]');
            if (newBtn) {
              const afterTop = newBtn.getBoundingClientRect().top;
              const delta = afterTop - beforeTop;
              if (delta !== 0) {
                const scroller = findScrollAncestor(content);
                if (scroller === window) window.scrollBy(0, delta);
                else scroller.scrollTop += delta;
              }
            }
          } else {
            content.dataset.userExpanded = '1';
            applyToolRowTruncation(content, profile);
          }
        });
        content.appendChild(btn);
      }
      if (btn.textContent !== btnText) btn.textContent = btnText;
      // React may append elements after our button across reconciles —
      // keep button at the tail so it sits below the clip box visually.
      if (content.lastChild !== btn) content.appendChild(btn);
    }

    // Grep filename click-to-open.
    //
    // Host already wires Read/Edit filenames to `context.fileOpener.open`,
    // which sends the normal `open_file` request through Claude Code's
    // existing webview -> extension channel. Reuse that exact opener instead
    // of adding an incipit message channel or calling `acquireVsCodeApi()`.
    //
    // Fragility: this reads the React function-component props above the
    // tool-use DOM node and expects a `context.fileOpener.open` shape. If
    // Claude Code refactors that prop, return null and leave the Grep filename
    // as tooltip-only text.
    const fileOpenerCap = defineCapability({
      name: 'runtime.fiber.fileOpener',
      layer: 'fiber',
      presence: 'always',
      shapeValidate: opener => opener && typeof opener.open === 'function',
      probe(el) {
        if (!el) return { ok: false, value: null, reason: 'notMounted' };
        const fk = reactFiberKeyForElement(el);
        if (!fk) return { ok: false, value: null, reason: 'noFiber' };
        let f = el[fk];
        for (let i = 0; i < 30 && f; i++) {
          const ctx = f.memoizedProps && f.memoizedProps.context;
          const opener = ctx && ctx.fileOpener;
          if (opener && typeof opener.open === 'function') {
            return { ok: true, value: opener, reason: 'ok' };
          }
          f = f.return;
        }
        return { ok: false, value: null, reason: 'shapeMiss' };
      },
    });

    function readHostFileOpener(el) {
      const result = fileOpenerCap.read(el);
      return result.ok ? result.value : null;
    }

    function validLineNumber(value) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }

    function firstGrepLineNumber(resultText, filePath) {
      if (!resultText) return null;
      const rawPath = typeof filePath === 'string' ? filePath.trim() : '';
      const normPath = rawPath.replace(/\\/g, '/');
      const parts = normPath.split('/').filter(Boolean);
      const basename = parts.length ? parts[parts.length - 1] : '';
      const candidates = [];
      if (normPath) candidates.push(normPath);
      if (basename && basename !== normPath) candidates.push(basename);

      const lines = String(resultText).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // File-scoped grep output often begins with `123:matched text`.
        let m = line.match(/^(\d+)(?=[:\-\s]|$)/);
        let n = m && validLineNumber(m[1]);
        if (n) return n;

        // Path-scoped output is usually `path:123:matched text`. Windows
        // drive letters are safe here because we match only after the known
        // full path or basename, not after every colon in the string.
        const normLine = line.replace(/\\/g, '/');
        for (let j = 0; j < candidates.length; j++) {
          const c = candidates[j];
          const idx = normLine.lastIndexOf(c);
          if (idx === -1) continue;
          if (c === basename && idx > 0 && normLine.charAt(idx - 1) !== '/') continue;
          const rest = normLine.slice(idx + c.length);
          m = rest.match(/^\s*[:\-\s]\s*(\d+)(?=[:\-\s]|$)/);
          n = m && validLineNumber(m[1]);
          if (n) return n;
        }
      }
      return null;
    }

    function bindGrepFilenameOpen(fnSpan, toolEl) {
      if (fnSpan.dataset.incipitToolGrepClickBound === '1') return;

      const open = (evt) => {
        const opener = readHostFileOpener(toolEl);
        const filePath = fnSpan.dataset.incipitToolGrepPath ||
                         fnSpan.dataset.incipitToolFullpath;
        if (!opener || !filePath) return;

        evt.preventDefault();
        evt.stopPropagation();

        const line = validLineNumber(fnSpan.dataset.incipitToolGrepLine);
        const location = line ? { startLine: line, endLine: line } : undefined;
        try {
          opener.open(filePath, location);
        } catch (e) {
          console.warn('[incipit] failed to open grep filename', e);
        }
      };

      fnSpan.addEventListener('click', open);
      fnSpan.addEventListener('keydown', evt => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        open(evt);
      });
      fnSpan.dataset.incipitToolGrepClickBound = '1';
    }

    // Generic tool header path support.
    //
    // Host-native Read/Edit/Write/NotebookEdit/ExitPlanMode already render
    // clickable anchors, but their visible text is often only a basename, so
    // `truncatePathSpan` cannot infer the full path for our tooltip. Other
    // file-ish tools (notably fallback-rendered MultiEdit / LSP-style tools)
    // may expose the file path only through the fiber `tool_use.input` object.
    //
    // Reuse the same host `context.fileOpener.open` object that Grep uses.
    // No new webview -> extension message channel, no acquireVsCodeApi patch.
    //
    // Fragility: this composes two existing pierces:
    //   1. `readToolUseBlock` for the tool input shape.
    //   2. `readHostFileOpener` for `context.fileOpener`.
    // If either host shape drifts, decoration falls back to tooltip-only
    // (or host-native anchors keep working by themselves).
    const toolPathOpenSpecs = new WeakMap();

    function basenameOfPath(filePath) {
      const s = typeof filePath === 'string' ? filePath.trim() : '';
      if (!s) return '';
      const parts = s.split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : s;
    }

    function isUrlLike(value) {
      return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(String(value || ''));
    }

    function looksLikeLocalPath(value, allowWhitespace) {
      const s = typeof value === 'string' ? value.trim() : '';
      if (!s || s.includes('\n') || isUrlLike(s)) return false;
      if (!allowWhitespace && /\s/.test(s)) return false;
      if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
      if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../') ||
          s.startsWith('.\\') || s.startsWith('..\\') || s.startsWith('~')) {
        return true;
      }
      if (s.includes('/') || s.includes('\\')) return true;
      return /\.[a-zA-Z0-9]{1,10}$/.test(s);
    }

    function looksLikeFilename(value) {
      const base = basenameOfPath(value);
      if (!base) return false;
      if (/\.[a-zA-Z0-9]{1,10}$/.test(base)) return true;
      return /^(Makefile|Dockerfile|Containerfile|Rakefile|Gemfile|Procfile|Brewfile)$/i.test(base);
    }

    function offsetLimitLocation(input) {
      const offset = input && input.offset !== void 0 ? Number(input.offset) : NaN;
      const start = Number.isFinite(offset) ? validLineNumber(offset + 1) : null;
      if (!start) return null;
      const limit = input.limit !== void 0 ? Number(input.limit) : NaN;
      const end = Number.isFinite(limit) ? validLineNumber(offset + limit) : null;
      return end ? { startLine: start, endLine: end } : { startLine: start };
    }

    function lineFieldLocation(input) {
      if (!input || typeof input !== 'object') return null;
      const start =
        validLineNumber(input.startLine) ||
        validLineNumber(input.lineNumber) ||
        validLineNumber(input.line);
      if (!start) return null;
      const end = validLineNumber(input.endLine) || start;
      return { startLine: start, endLine: end };
    }

    function firstMultiEditSearchText(input) {
      const edits = input && Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (edit && typeof edit.new_string === 'string' && edit.new_string) return edit.new_string;
      }
      return null;
    }

    function makePathSpec(path, source, location, preferInject) {
      const allowWhitespace = source !== 'path';
      if (!looksLikeLocalPath(path, allowWhitespace)) return null;
      // Bare `path` is ambiguous in MCP / search-like tools: it may be a
      // server route or a directory root. Treat it as a file only when the
      // basename looks file-like or line metadata makes the file intent clear.
      if (source === 'path' && !location && !looksLikeFilename(path)) return null;
      return {
        path: path.trim(),
        source,
        location: location || null,
        preferInject: !!preferInject,
      };
    }

    function toolFilePathSpecs(block) {
      if (!block || !block.input || typeof block.input !== 'object') return [];
      const input = block.input;
      const name = block.name;
      const specs = [];
      const push = (path, source, location, preferInject) => {
        const spec = makePathSpec(path, source, location, preferInject);
        if (spec) specs.push(spec);
      };

      if (name === 'Grep') return specs; // Grep owns its custom filename UI.

      if (name === 'ReadCoalesced' && Array.isArray(input.fileReads)) {
        for (const fileRead of input.fileReads) {
          if (!fileRead || typeof fileRead !== 'object') continue;
          push(fileRead.file_path, 'fileReads.file_path', offsetLimitLocation(fileRead), false);
        }
        return specs;
      }

      if (typeof input.file_path === 'string') {
        let location = offsetLimitLocation(input) || lineFieldLocation(input);
        if (!location && name === 'Edit' && typeof input.new_string === 'string' && input.new_string) {
          location = { searchText: input.new_string };
        } else if (!location && name === 'MultiEdit') {
          const searchText = firstMultiEditSearchText(input);
          if (searchText) location = { searchText };
        }
        push(input.file_path, 'file_path', location, name === 'MultiEdit');
      }

      if (typeof input.notebook_path === 'string') {
        push(input.notebook_path, 'notebook_path', null, false);
      }

      if (typeof input.planFilePath === 'string') {
        push(input.planFilePath, 'planFilePath', null, false);
      }

      if (typeof input.filePath === 'string') {
        push(input.filePath, 'filePath', lineFieldLocation(input), false);
      }

      // Generic `path` is often a search directory for Grep/Glob/Search.
      // Only treat it as file-ish for other tools and only when it passes
      // the local-path probe above.
      if (!specs.length &&
          name !== 'Glob' &&
          name !== 'Search' &&
          typeof input.path === 'string') {
        push(input.path, 'path', lineFieldLocation(input), false);
      }

      return specs;
    }

    function firstToolPathForDisplay(block) {
      if (!block || !block.input || typeof block.input !== 'object') return '';
      const specs = toolFilePathSpecs(block);
      if (specs.length && specs[0].path) return specs[0].path;

      const input = block.input;
      const fields = ['file_path', 'filePath', 'path', 'notebook_path', 'planFilePath'];
      for (const field of fields) {
        if (typeof input[field] === 'string' && input[field].trim()) {
          return input[field].trim();
        }
      }
      return '';
    }

    function languageClassForFilePath(filePath) {
      const base = basenameOfPath(filePath).toLowerCase();
      const m = base.match(/\.([a-z0-9]+)$/);
      const ext = m ? m[1] : base;
      const langByExt = {
        bash: 'bash',
        bat: 'dos',
        c: 'c',
        cc: 'cpp',
        cls: 'apex',
        cmd: 'dos',
        cpp: 'cpp',
        cs: 'csharp',
        css: 'css',
        csv: 'csv',
        cxx: 'cpp',
        diff: 'diff',
        dockerfile: 'dockerfile',
        go: 'go',
        h: 'cpp',
        hpp: 'cpp',
        html: 'xml',
        ini: 'ini',
        java: 'java',
        js: 'javascript',
        json: 'json',
        jsonl: 'json',
        jsx: 'javascript',
        kt: 'kotlin',
        less: 'less',
        lua: 'lua',
        m: 'objectivec',
        // Diff previews must display markdown-family files as literal source.
        // highlight.js' markdown lexer injects semantic spans such as
        // `.hljs-strong` / `.hljs-bullet`, which visually reads as markdown
        // rendering inside the diff. Force these files through plaintext.
        markdown: 'plaintext',
        md: 'plaintext',
        mdx: 'plaintext',
        mdown: 'plaintext',
        mkd: 'plaintext',
        mjs: 'javascript',
        mm: 'objectivec',
        patch: 'diff',
        php: 'php',
        ps1: 'powershell',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        scss: 'scss',
        sh: 'bash',
        sql: 'sql',
        swift: 'swift',
        toml: 'toml',
        ts: 'typescript',
        tsx: 'typescript',
        txt: 'plaintext',
        xml: 'xml',
        yaml: 'yaml',
        yml: 'yaml',
      };
      const lang = langByExt[ext] || 'plaintext';
      return 'language-' + lang;
    }

    function findDirectChildByAttr(parent, attrName) {
      if (!parent || !parent.children) return null;
      for (const child of parent.children) {
        if (child && child.hasAttribute && child.hasAttribute(attrName)) return child;
      }
      return null;
    }

    function ensureDiffHeader(container) {
      if (!container) return null;
      let header = findDirectChildByAttr(container, 'data-incipit-diff-header');
      let titleSpan, countsSpan, addedSpan, removedSpan;
      if (!header) {
        header = document.createElement('div');
        header.setAttribute('data-incipit-diff-header', '');

        titleSpan = document.createElement('span');
        titleSpan.setAttribute('data-incipit-diff-title', '');
        countsSpan = document.createElement('span');
        countsSpan.setAttribute('data-incipit-diff-counts', '');
        addedSpan = document.createElement('span');
        addedSpan.setAttribute('data-incipit-tool-added', '');
        removedSpan = document.createElement('span');
        removedSpan.setAttribute('data-incipit-tool-removed', '');

        countsSpan.appendChild(addedSpan);
        countsSpan.appendChild(removedSpan);
        header.appendChild(titleSpan);
        header.appendChild(countsSpan);
        container.insertBefore(header, container.firstChild);
      } else {
        titleSpan = header.querySelector('[data-incipit-diff-title]');
        countsSpan = header.querySelector('[data-incipit-diff-counts]');
        addedSpan = header.querySelector('[data-incipit-tool-added]');
        removedSpan = header.querySelector('[data-incipit-tool-removed]');
      }

      if (!titleSpan || !countsSpan || !addedSpan || !removedSpan) return null;
      return { header, titleSpan, countsSpan, addedSpan, removedSpan };
    }

    function updateDiffHeader(container, block, stats) {
      const parts = ensureDiffHeader(container);
      if (!parts) return null;
      const { titleSpan, addedSpan, removedSpan } = parts;

      const filePath = firstToolPathForDisplay(block);
      const title = basenameOfPath(filePath) || filePath || 'diff';
      if (titleSpan.textContent !== title) titleSpan.textContent = title;
      if (filePath) {
        if (titleSpan.dataset.incipitToolFullpath !== filePath) {
          titleSpan.dataset.incipitToolFullpath = filePath;
        }
      } else if (titleSpan.dataset.incipitToolFullpath) {
        delete titleSpan.dataset.incipitToolFullpath;
      }

      const wantAdded = '+' + stats.added;
      const wantRemoved = '\u2212' + stats.removed;
      if (addedSpan.textContent !== wantAdded) addedSpan.textContent = wantAdded;
      if (removedSpan.textContent !== wantRemoved) removedSpan.textContent = wantRemoved;
      return parts.header;
    }

    function decorateInlineDiffHeader(body, block, stats) {
      const wrapper = body && body.querySelector && body.querySelector('[class*="diffEditorWrapper"]');
      if (!wrapper) return;

      const header = findDirectChildByAttr(wrapper, 'data-incipit-diff-header');
      if (!stats) {
        if (header) header.remove();
        return;
      }

      updateDiffHeader(wrapper, block, stats);
      const lineInfoKey = ensureDiffLineInfo(wrapper, block);
      bindDiffModalKeyCapture(wrapper, lineInfoKey);
      scheduleDiffSideBars();
    }

    function cleanupWriteDiffBody(el, body) {
      if (el && el.dataset.incipitToolWriteDiff) delete el.dataset.incipitToolWriteDiff;
      if (el && el.dataset.incipitToolDiffIsland) delete el.dataset.incipitToolDiffIsland;
      const diff = body && body.querySelector && body.querySelector(':scope > [data-incipit-write-diff]');
      if (diff) diff.remove();
    }

    const WRITE_DIFF_PREVIEW_LINES = 10;
    const WRITE_DIFF_FULL_BELOW_LINES = 12;
    let writeDiffModal = null;

    function writeDiffLines(text) {
      return text === '' ? [] : String(text).split('\n');
    }

    function rangesFromChangedIndexes(indexes) {
      if (!indexes.length) return [];
      const ranges = [];
      let start = indexes[0];
      let prev = indexes[0];
      for (let i = 1; i < indexes.length; i++) {
        const cur = indexes[i];
        if (cur === prev + 1) {
          prev = cur;
          continue;
        }
        ranges.push([start, prev + 1]);
        start = prev = cur;
      }
      ranges.push([start, prev + 1]);
      return ranges;
    }

    function lcsLength(a, b, maxCells) {
      const m = a.length;
      const n = b.length;
      if (!m || !n) return 0;
      if (maxCells && m * n > maxCells) return null;
      const prev = new Uint32Array(n + 1);
      const curr = new Uint32Array(n + 1);
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          curr[j] = a[i - 1] === b[j - 1]
            ? prev[j - 1] + 1
            : Math.max(prev[j], curr[j - 1]);
        }
        prev.set(curr);
      }
      return prev[n];
    }

    function diffLineTokens(text) {
      return String(text || '').match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_$]/g) || [];
    }

    function prefixSuffixSimilarity(a, b) {
      let prefix = 0;
      while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
      let aEnd = a.length;
      let bEnd = b.length;
      while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) {
        aEnd--;
        bEnd--;
      }
      return (2 * (prefix + (a.length - aEnd))) / (a.length + b.length);
    }

    function intralinePairScore(oldText, newText) {
      const oldTrimmed = String(oldText || '').trim();
      const newTrimmed = String(newText || '').trim();
      if (!oldTrimmed || !newTrimmed || oldTrimmed === newTrimmed) return 0;

      const oldChars = Array.from(oldTrimmed);
      const newChars = Array.from(newTrimmed);
      const lengthRatio = Math.min(oldChars.length, newChars.length) /
        Math.max(oldChars.length, newChars.length);
      if (lengthRatio < 0.35) return 0;

      const charLcs = lcsLength(oldChars, newChars, 40000);
      const charSimilarity = charLcs == null
        ? prefixSuffixSimilarity(oldChars, newChars)
        : (2 * charLcs) / (oldChars.length + newChars.length);

      const oldTokens = diffLineTokens(oldTrimmed);
      const newTokens = diffLineTokens(newTrimmed);
      const tokenLcs = lcsLength(oldTokens, newTokens, 40000);
      const tokenSimilarity = tokenLcs == null
        ? prefixSuffixSimilarity(oldTokens, newTokens)
        : (oldTokens.length || newTokens.length)
          ? (2 * tokenLcs) / (oldTokens.length + newTokens.length)
          : charSimilarity;

      // GitHub-style intraline tint is for local edits within the same logical
      // line, not for whole-line additions/deletions or block rewrites. Require
      // both character and token similarity so unrelated comment/code lines do
      // not get noisy "common letter" highlights. The strong-char escape keeps
      // punctuation-only edits such as adding a semicolon visible.
      if (charSimilarity >= 0.62 && tokenSimilarity >= 0.58) {
        return (charSimilarity * 2) + tokenSimilarity;
      }
      if (charSimilarity >= 0.82 && tokenSimilarity >= 0.45) {
        return charSimilarity + tokenSimilarity;
      }
      return 0;
    }

    function fallbackCharRanges(oldChars, newChars) {
      let prefix = 0;
      while (prefix < oldChars.length &&
             prefix < newChars.length &&
             oldChars[prefix] === newChars[prefix]) {
        prefix++;
      }

      let oldEnd = oldChars.length;
      let newEnd = newChars.length;
      while (oldEnd > prefix &&
             newEnd > prefix &&
             oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }

      return {
        old: prefix < oldEnd ? [[prefix, oldEnd]] : [],
        new: prefix < newEnd ? [[prefix, newEnd]] : [],
      };
    }

    function diffCharRanges(oldText, newText) {
      if (oldText === newText) return { old: [], new: [] };
      const oldChars = Array.from(String(oldText || ''));
      const newChars = Array.from(String(newText || ''));
      const m = oldChars.length;
      const n = newChars.length;
      if (!m || !n) {
        return {
          old: m ? [[0, m]] : [],
          new: n ? [[0, n]] : [],
        };
      }

      // Char-level LCS is only for paired replacement lines. Keep a hard cap
      // so an unusually long minified line cannot spend a frame building a
      // huge table; the prefix/suffix fallback still gives useful GitHub-like
      // changed-middle highlighting.
      if (m * n > 40000) return fallbackCharRanges(oldChars, newChars);

      const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i][j] = oldChars[i] === newChars[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }

      const oldChanged = [];
      const newChanged = [];
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        if (oldChars[i] === newChars[j]) {
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          oldChanged.push(i++);
        } else {
          newChanged.push(j++);
        }
      }
      while (i < m) oldChanged.push(i++);
      while (j < n) newChanged.push(j++);

      return {
        old: rangesFromChangedIndexes(oldChanged),
        new: rangesFromChangedIndexes(newChanged),
      };
    }

    function annotateIncipitDiffRows(rows) {
      let i = 0;
      while (i < rows.length) {
        if (rows[i].kind === 'ctx' || rows[i].kind === 'gap') {
          i++;
          continue;
        }
        const start = i;
        while (i < rows.length && rows[i].kind !== 'ctx' && rows[i].kind !== 'gap') i++;
        const run = rows.slice(start, i);
        const dels = run.filter(row => row.kind === 'del');
        const adds = run.filter(row => row.kind === 'add');
        if (!dels.length || !adds.length) continue;

        const m = dels.length;
        const n = adds.length;
        // Large rewrite hunks are precisely where intraline pairing becomes
        // least trustworthy: there may be many unrelated deleted/added lines
        // sharing common words or syntax. Keep those as whole-line shallow
        // add/del rows instead of spending a frame building another cross
        // product and risking noisy deep tints.
        if (m * n > 2500) continue;

        const scores = Array.from({ length: m }, () => new Array(n).fill(0));
        for (let di = 0; di < m; di++) {
          for (let aj = 0; aj < n; aj++) {
            scores[di][aj] = intralinePairScore(dels[di].text, adds[aj].text);
          }
        }

        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let di = m - 1; di >= 0; di--) {
          for (let aj = n - 1; aj >= 0; aj--) {
            const pair = scores[di][aj] > 0 ? scores[di][aj] + dp[di + 1][aj + 1] : 0;
            dp[di][aj] = Math.max(pair, dp[di + 1][aj], dp[di][aj + 1]);
          }
        }

        let di = 0;
        let aj = 0;
        while (di < m && aj < n) {
          const pair = scores[di][aj] > 0 ? scores[di][aj] + dp[di + 1][aj + 1] : -1;
          if (pair >= dp[di + 1][aj] && pair >= dp[di][aj + 1] && scores[di][aj] > 0) {
            const ranges = diffCharRanges(dels[di].text, adds[aj].text);
            dels[di].charRanges = ranges.old;
            adds[aj].charRanges = ranges.new;
            di++;
            aj++;
          } else if (dp[di + 1][aj] >= dp[di][aj + 1]) {
            di++;
          } else {
            aj++;
          }
        }
      }
      return rows;
    }

    function buildIncipitDiffRows(payload) {
      if (payload && Array.isArray(payload.rows)) {
        const rows = payload.rows.map(row => {
          const kind = row && (row.kind === 'add' || row.kind === 'del' || row.kind === 'ctx' || row.kind === 'gap')
            ? row.kind
            : 'ctx';
          return {
            kind,
            oldLine: diffPositiveLineNumber(row && row.oldLine) || null,
            newLine: diffPositiveLineNumber(row && row.newLine) || null,
            text: typeof (row && row.text) === 'string' ? row.text : '',
            absoluteLineNumber: true,
          };
        });
        return annotateIncipitDiffRows(rows);
      }
      const oldLines = writeDiffLines(payload.oldText);
      const newLines = writeDiffLines(payload.newText);
      if (!oldLines.length) {
        return newLines.map((text, i) => ({
          kind: 'add',
          oldLine: null,
          newLine: i + 1,
          text,
        }));
      }

      const m = oldLines.length;
      const n = newLines.length;
      // Keep the LCS exact for normal tool payloads. If the replacement is
      // huge, degrade to "all old removed, all new added" rather than spending
      // a frame building a massive DP table.
      if (m * n > 500000) {
        const rows = [];
        for (let i = 0; i < m; i++) rows.push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
        for (let j = 0; j < n; j++) rows.push({ kind: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
        return annotateIncipitDiffRows(rows);
      }

      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i][j] = oldLines[i] === newLines[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }

      const rows = [];
      let i = 0, j = 0;
      while (i < m && j < n) {
        if (oldLines[i] === newLines[j]) {
          rows.push({ kind: 'ctx', oldLine: i + 1, newLine: j + 1, text: newLines[j] });
          i++; j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          rows.push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
          i++;
        } else {
          rows.push({ kind: 'add', oldLine: null, newLine: j + 1, text: newLines[j] });
          j++;
        }
      }
      while (i < m) rows.push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i++] });
      while (j < n) rows.push({ kind: 'add', oldLine: null, newLine: j + 1, text: newLines[j++] });
      return annotateIncipitDiffRows(rows);
    }

    function lineInfoBases(lineInfo) {
      const oldBase = diffPositiveLineNumber(lineInfo && (lineInfo.oldStartLine || lineInfo.startLine)) || 1;
      const newBase = diffPositiveLineNumber(lineInfo && (lineInfo.newStartLine || lineInfo.startLine)) || 1;
      return { oldBase, newBase };
    }

    function fillWriteDiffBody(bodyEl, payload, languageClass, lineInfo) {
      while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

      const rows = buildIncipitDiffRows(payload);
      const { oldBase, newBase } = lineInfoBases(lineInfo);

      for (const row of rows) {
        const rowEl = document.createElement('div');
        rowEl.setAttribute('data-incipit-diff-island-row', row.kind);
        rowEl.setAttribute('data-incipit-write-diff-row', row.kind);

        const n = document.createElement('span');
        n.setAttribute('data-incipit-diff-island-number', '');
        n.setAttribute('data-incipit-write-diff-number', '');
        const rawLine = row.kind === 'del'
          ? row.oldLine
          : row.kind === 'add'
            ? row.newLine
            : (row.newLine || row.oldLine);
        const base = row.kind === 'del' ? oldBase : newBase;
        n.textContent = rawLine
          ? String(row.absoluteLineNumber ? rawLine : base + rawLine - 1)
          : '';

        const pre = document.createElement('pre');
        pre.setAttribute('data-incipit-diff-island-pre', '');
        pre.setAttribute('data-incipit-write-diff-pre', '');
        const code = document.createElement('code');
        code.setAttribute('data-incipit-diff-island-code', '');
        code.setAttribute('data-incipit-write-diff-code', '');
        if (languageClass && row.kind !== 'gap') code.className = languageClass;
        code.textContent = row.text;
        code.__incipitDiffCharKind = row.kind;
        code.__incipitDiffCharRanges = row.charRanges || [];
        pre.appendChild(code);

        rowEl.appendChild(n);
        rowEl.appendChild(pre);
        bodyEl.appendChild(rowEl);
      }
    }

    function incipitCodeUnitOffsetForCodePoint(text, offset) {
      if (offset <= 0) return 0;
      let units = 0;
      let points = 0;
      for (const ch of String(text || '')) {
        if (points >= offset) break;
        units += ch.length;
        points++;
      }
      return units;
    }

    function wrapIncipitDiffTextNodeRange(node, start, end, kind) {
      if (!node || !node.parentNode || end <= start) return;
      const text = node.nodeValue || '';
      const startOffset = incipitCodeUnitOffsetForCodePoint(text, start);
      const endOffset = incipitCodeUnitOffsetForCodePoint(text, end);
      if (endOffset <= startOffset) return;

      let target = node;
      if (endOffset < text.length) target.splitText(endOffset);
      if (startOffset > 0) target = target.splitText(startOffset);
      if (!target.nodeValue) return;

      const span = document.createElement('span');
      span.setAttribute('data-incipit-diff-island-char', kind);
      span.setAttribute('data-incipit-write-diff-char', kind);
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
    }

    function applyIncipitDiffCharRangesToCode(code) {
      const ranges = Array.isArray(code && code.__incipitDiffCharRanges)
        ? code.__incipitDiffCharRanges
        : [];
      const kind = code && code.__incipitDiffCharKind;
      if (!code || code.dataset.incipitDiffCharsApplied === '1' || !ranges.length ||
          (kind !== 'add' && kind !== 'del')) {
        return;
      }

      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement && node.parentElement.closest('[data-incipit-diff-island-char]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let pos = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const length = Array.from(node.nodeValue || '').length;
        if (length > 0) {
          nodes.push({ node, start: pos, end: pos + length });
          pos += length;
        }
      }

      for (let r = ranges.length - 1; r >= 0; r--) {
        const range = ranges[r];
        if (!range || range.length < 2) continue;
        const start = range[0];
        const end = range[1];
        for (let i = nodes.length - 1; i >= 0; i--) {
          const item = nodes[i];
          const a = Math.max(start, item.start);
          const b = Math.min(end, item.end);
          if (b <= a) continue;
          wrapIncipitDiffTextNodeRange(item.node, a - item.start, b - item.start, kind);
        }
      }
      code.dataset.incipitDiffCharsApplied = '1';
    }

    function highlightDiffIsland(container) {
      const typography = globalThis.__incipitTypography;
      if (typography && typeof typography.highlightAllCode === 'function') {
        typography.highlightAllCode(container);
      }
      container.querySelectorAll?.('[data-incipit-diff-island-code], [data-incipit-write-diff-code]')
        .forEach(code => applyIncipitDiffCharRangesToCode(code));
    }

    function closeWriteDiffModal() {
      if (!writeDiffModal) return;
      const modal = writeDiffModal;
      writeDiffModal = null;
      document.removeEventListener('keydown', modal.onKeyDown, true);
      if (modal.backdrop && modal.backdrop.parentElement) modal.backdrop.remove();
    }

    function openWriteDiffModal(payload, block, stats, languageClass, lineInfo) {
      closeWriteDiffModal();
      if (!document.body) return;

      const backdrop = document.createElement('div');
      backdrop.setAttribute('data-incipit-write-diff-modal', '');

      const content = document.createElement('div');
      content.setAttribute('data-incipit-write-diff-modal-content', '');
      backdrop.appendChild(content);

      const header = document.createElement('div');
      header.setAttribute('data-incipit-write-diff-modal-header', '');

      const title = document.createElement('span');
      title.setAttribute('data-incipit-write-diff-modal-title', '');
      const filePath = firstToolPathForDisplay(block);
      title.textContent = basenameOfPath(filePath) || filePath || 'diff';
      if (filePath) title.dataset.incipitToolFullpath = filePath;

      const counts = document.createElement('span');
      counts.setAttribute('data-incipit-diff-counts', '');
      const added = document.createElement('span');
      added.setAttribute('data-incipit-tool-added', '');
      added.textContent = '+' + (stats ? stats.added : writeDiffLines(payload.newText).length);
      const removed = document.createElement('span');
      removed.setAttribute('data-incipit-tool-removed', '');
      removed.textContent = '\u2212' + (stats ? stats.removed : 0);
      counts.appendChild(added);
      counts.appendChild(removed);

      const close = document.createElement('button');
      close.type = 'button';
      close.setAttribute('data-incipit-write-diff-modal-close', '');
      close.setAttribute('aria-label', legacyText('close_diff'));
      close.textContent = '\u00d7';
      close.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        closeWriteDiffModal();
      });

      header.appendChild(title);
      header.appendChild(counts);
      header.appendChild(close);
      content.appendChild(header);

      const scroll = document.createElement('div');
      scroll.setAttribute('data-incipit-write-diff-modal-scroll', '');
      const bodyEl = document.createElement('div');
      bodyEl.setAttribute('data-incipit-diff-island-body', '');
      bodyEl.setAttribute('data-incipit-write-diff-body', '');
      fillWriteDiffBody(bodyEl, payload, languageClass, lineInfo);
      scroll.appendChild(bodyEl);
      content.appendChild(scroll);

      backdrop.addEventListener('click', evt => {
        if (evt.target !== backdrop) return;
        evt.preventDefault();
        closeWriteDiffModal();
      });
      const onKeyDown = evt => {
        if (evt.key !== 'Escape') return;
        evt.preventDefault();
        closeWriteDiffModal();
      };
      document.addEventListener('keydown', onKeyDown, true);
      writeDiffModal = { backdrop, onKeyDown };

      document.body.appendChild(backdrop);
      highlightDiffIsland(content);
    }

    registerChangeReviewWriteDiffRenderer(openWriteDiffModal, languageClassForFilePath);

    function ensureWriteDiffPreviewControls(diff, payload, block, stats, languageClass, lineInfo) {
      const clipped = buildIncipitDiffRows(payload).length > WRITE_DIFF_FULL_BELOW_LINES;
      diff.style.setProperty(
        '--incipit-write-diff-preview-max-height',
        (WRITE_DIFF_PREVIEW_LINES * 1.55) + 'em'
      );
      if (clipped) diff.dataset.incipitWriteDiffClipped = '1';
      else delete diff.dataset.incipitWriteDiffClipped;

      let gradient = findDirectChildByAttr(diff, 'data-incipit-write-diff-gradient');
      let button = findDirectChildByAttr(diff, 'data-incipit-write-diff-expand');

      if (!clipped && gradient) {
        gradient.remove();
        gradient = null;
      }

      if (clipped && !gradient) {
        gradient = document.createElement('div');
        gradient.setAttribute('data-incipit-write-diff-gradient', '');
        diff.appendChild(gradient);
      }

      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-incipit-write-diff-expand', '');
        button.addEventListener('click', evt => {
          evt.preventDefault();
          evt.stopPropagation();
          const open = button.__incipitOpenWriteDiff;
          if (typeof open === 'function') open();
        });
        diff.appendChild(button);
      }
      const buttonText = clipped ? legacyText('click_to_expand') : legacyText('open');
      if (button.textContent !== buttonText) button.textContent = buttonText;
      button.__incipitOpenWriteDiff = () => openWriteDiffModal(payload, block, stats, languageClass, lineInfo);
    }

    function ensureWriteDiffBody(el, body, block, stats) {
      const payload = incipitDiffPayload(block);
      if (!payload || !body || !body.querySelector) {
        cleanupWriteDiffBody(el, body);
        return;
      }

      if (el.dataset.incipitToolWriteDiff !== '1') el.dataset.incipitToolWriteDiff = '1';
      if (el.dataset.incipitToolDiffIsland !== '1') el.dataset.incipitToolDiffIsland = '1';

      let diff = body.querySelector(':scope > [data-incipit-write-diff]');
      if (!diff) {
        diff = document.createElement('div');
        diff.setAttribute('data-incipit-diff-island', '');
        diff.setAttribute('data-incipit-write-diff', '');
        body.insertBefore(diff, body.firstChild);
      }

      updateDiffHeader(diff, block, stats || { added: 0, removed: 0 });
      const lineInfoKey = ensureDiffLineInfo(diff, block);
      const lineInfo = lineInfoKey ? diffLineInfoByKey.get(lineInfoKey) : null;

      const languageClass = languageClassForFilePath(payload.filePath);
      const lineSig = lineInfo
        ? [lineInfo.status, lineInfo.oldStartLine || '', lineInfo.newStartLine || '', lineInfo.startLine || ''].join(':')
        : '';
      const sig = payload.filePath + '\n' + languageClass + '\n' + lineSig + '\n' +
        payload.oldText + '\n---\n' + payload.newText;
      if (diff.__incipitWriteDiffSig === sig) {
        ensureWriteDiffPreviewControls(diff, payload, block, stats || { added: 0, removed: 0 }, languageClass, lineInfo);
        highlightDiffIsland(diff);
        return;
      }
      diff.__incipitWriteDiffSig = sig;

      let bodyEl = findDirectChildByAttr(diff, 'data-incipit-write-diff-body');
      if (!bodyEl) {
        bodyEl = document.createElement('div');
        bodyEl.setAttribute('data-incipit-diff-island-body', '');
        bodyEl.setAttribute('data-incipit-write-diff-body', '');
        diff.appendChild(bodyEl);
      }
      fillWriteDiffBody(bodyEl, payload, languageClass, lineInfo);
      ensureWriteDiffPreviewControls(diff, payload, block, stats || { added: 0, removed: 0 }, languageClass, lineInfo);
      highlightDiffIsland(diff);
    }

    function normalizePathForMatch(value) {
      return String(value || '').replace(/\\/g, '/');
    }

    function candidateMatchesPath(candidate, spec) {
      const text = (candidate.textContent || '').trim();
      if (!text) return false;
      const base = basenameOfPath(spec.path);
      if (base && (text === base || text.startsWith(base + ':') || text.includes(base))) {
        return true;
      }
      const normText = normalizePathForMatch(text);
      const normPath = normalizePathForMatch(spec.path);
      if (normText === normPath) return true;
      if (normText.charCodeAt(0) === 0x2026) {
        const tail = normText.slice(1).replace(/^[/\\]+/, '');
        if (tail && normPath.endsWith(tail)) return true;
      }
      const hostShort = spec.path.length > 40 ? spec.path.slice(0, 40) + '\u2026' : spec.path;
      return text === hostShort;
    }

    function summaryPathCandidates(summary) {
      if (!summary) return [];
      return Array.from(summary.querySelectorAll(
        '[data-incipit-tool-filepath], [class*="toolNameTextSecondary"], [class*="filePath"], [data-incipit-tool-fingerprint]'
      )).filter(node => {
        if (!node || node.closest('[data-incipit-tool-stats]')) return false;
        if (node.hasAttribute('data-incipit-tool-grep-filename')) return false;
        return true;
      });
    }

    function hasNativeAnchor(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.matches && el.matches('a[href]')) return true;
      return !!(el.querySelector && el.querySelector('a[href]'));
    }

    function bindToolPathOpen(pathEl, toolEl) {
      if (pathEl.dataset.incipitToolPathClickBound === '1') return;
      const open = (evt) => {
        const spec = toolPathOpenSpecs.get(pathEl);
        const opener = readHostFileOpener(toolEl);
        if (!spec || !spec.path || !opener) return;
        evt.preventDefault();
        evt.stopPropagation();
        try {
          opener.open(spec.path, spec.location || undefined);
        } catch (e) {
          console.warn('[incipit] failed to open tool path', e);
        }
      };
      pathEl.addEventListener('click', open);
      pathEl.addEventListener('keydown', evt => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        open(evt);
      });
      pathEl.dataset.incipitToolPathClickBound = '1';
    }

    function stampToolPathNode(pathEl, spec, toolEl) {
      if (!pathEl || !spec || !spec.path) return;
      pathEl.dataset.incipitToolFullpath = spec.path;
      pathEl.dataset.incipitToolOpenPath = spec.path;
      pathEl.dataset.incipitToolPathSource = spec.source || '';
      toolPathOpenSpecs.set(pathEl, spec);

      const opener = readHostFileOpener(toolEl);
      if (opener) {
        pathEl.dataset.incipitToolOpenable = '1';
      } else {
        delete pathEl.dataset.incipitToolOpenable;
      }

      // Host anchors already carry the exact React onClick closure. Do not
      // wrap or double-fire them; just add tooltip metadata to their outer
      // span. Plain spans get our generic click/key handler.
      if (hasNativeAnchor(pathEl)) return;

      if (opener) {
        pathEl.setAttribute('role', 'button');
        pathEl.tabIndex = 0;
        bindToolPathOpen(pathEl, toolEl);
      } else {
        pathEl.removeAttribute('role');
        pathEl.removeAttribute('tabindex');
      }
    }

    function findCandidateForSpec(candidates, used, specs, spec, index) {
      for (const candidate of candidates) {
        if (used.has(candidate)) continue;
        if (candidateMatchesPath(candidate, spec)) return candidate;
      }
      const remaining = candidates.filter(c => !used.has(c));
      if (specs.length === candidates.length && remaining.length) return remaining[0];
      if (specs.length === 1 && remaining.length === 1) return remaining[0];
      return null;
    }

    function findToolPathInsertHost(summary) {
      const titleWrap = summary && summary.firstElementChild;
      if (!titleWrap) return summary;
      const toolNameEl = titleWrap.querySelector('[class*="toolNameText_"]')
                       || titleWrap.querySelector('[data-incipit-tool-name]');
      return toolNameEl ? toolNameEl.parentElement : titleWrap;
    }

    function findToolSummaryInlineHost(summary, titleWrap) {
      const toolNameEl = titleWrap && (
        titleWrap.querySelector('[class*="toolNameText_"]') ||
        titleWrap.querySelector('[data-incipit-tool-name]')
      );
      return (toolNameEl && toolNameEl.parentElement) || titleWrap || summary;
    }

    function ensureInjectedToolPath(summary, spec, index) {
      const host = findToolPathInsertHost(summary);
      if (!host) return null;
      const key = (spec.source || 'path') + ':' + index;
      let span = null;
      const existing = host.querySelectorAll('[data-incipit-tool-filepath]');
      for (const node of existing) {
        if (node.dataset.incipitToolPathKey === key) {
          span = node;
          break;
        }
      }
      if (!span) {
        span = document.createElement('span');
        span.setAttribute('data-incipit-tool-filepath', '');
        span.dataset.incipitToolPathKey = key;
        host.appendChild(span);
      }
      if (span.dataset.incipitToolOpenPath !== spec.path) {
        span.textContent = spec.path;
        delete span.dataset.incipitToolFullpath;
        truncatePathSpan(span);
        span.dataset.incipitToolFullpath = spec.path;
      }
      return span;
    }

    function decorateToolFilePaths(el, summary, data) {
      const block = data && data.block;
      if (!block || !summary) return;
      const specs = toolFilePathSpecs(block);
      if (!specs.length) return;

      const candidates = summaryPathCandidates(summary);
      const used = new Set();
      specs.forEach((spec, index) => {
        let target = findCandidateForSpec(candidates, used, specs, spec, index);
        if (target) {
          used.add(target);
        } else if (spec.preferInject || spec.source !== 'path') {
          target = ensureInjectedToolPath(summary, spec, index);
        }
        if (target) stampToolPathNode(target, spec, el);
      });
    }

    function handleGrepAuxLayout(el, summary, data) {
      const isGrep = !!(data && data.block && data.block.name === 'Grep');
      if (!isGrep || !summary) {
        if (el.dataset.incipitToolGrep) delete el.dataset.incipitToolGrep;
        ['[data-incipit-tool-fingerprint-aux]',
         '[data-incipit-tool-grep-filename]',
         '[data-incipit-tool-grep-chevron]',
         '[data-incipit-tool-grep-expansion]'].forEach(sel => {
          const node = el.querySelector(sel);
          if (node) node.remove();
        });
        return;
      }
      const titleWrap = summary.firstElementChild;
      if (!titleWrap) return;
      if (el.dataset.incipitToolGrep !== '1') el.dataset.incipitToolGrep = '1';
      if (!el.dataset.incipitToolCollapsed) snapInitialCollapse(el);

      const input = (data.block && data.block.input) || {};
      const path = typeof input.path === 'string' ? input.path : '';
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      const root = summary.parentElement;
      const hostSec = root && root.querySelector(':scope > [class*="secondaryLine_"]');
      const hostText = hostSec && hostSec.textContent ? hostSec.textContent.trim() : '';
      // Try to recover the actual tool_result via fiber sibling — host
      // doesn't render Grep output into a toolBody, so this is the only
      // path to the real matched lines. Falls back to host text if pierce
      // fails (different React version, missing sibling, etc).
      const resultBlock = readToolResult(data.block, el);
      const resultText = extractResultText(resultBlock);
      const firstLine = firstGrepLineNumber(resultText, path);
      const fileOpener = path ? readHostFileOpener(el) : null;

      // Insertion host — host wraps `toolName` and `toolNameTextSecondary`
      // inside an inner `<div>` (block element) under titleWrap. Appending
      // our spans to titleWrap puts them after that block, which breaks
      // the row visually ("Grep" sits alone, our spans wrap below). Insert
      // siblings to toolName instead so the inline flow stays single-line.
      const toolNameEl = titleWrap.querySelector('[class*="toolNameText_"]')
                       || titleWrap.querySelector('[data-incipit-tool-name]');
      const insertHost = toolNameEl ? toolNameEl.parentElement : titleWrap;

      // 1. fileName span — full input.path; truncatePathSpan replaces the
      // textContent with `…\parent\basename` and stamps fullpath attr.
      //
      // After truncate, force `data-incipit-tool-fullpath = path`
      // unconditionally — truncatePathSpan only stamps it for paths with
      // ≥3 segments, but we want every Grep filename to get (a) the hover
      // tooltip and (b) the click-skip rule that prevents the filename
      // area from toggling the surrounding fold. Use a separate sentinel
      // (`data-incipit-tool-grep-path`) for change detection so the
      // refresh path stays correct even though fullpath is now constant
      // per row.
      let fnSpan = insertHost.querySelector('[data-incipit-tool-grep-filename]');
      if (path) {
        if (!fnSpan) {
          fnSpan = document.createElement('span');
          fnSpan.setAttribute('data-incipit-tool-grep-filename', '');
          insertHost.appendChild(fnSpan);
        }
        if (fnSpan.dataset.incipitToolGrepPath !== path) {
          fnSpan.dataset.incipitToolGrepPath = path;
          fnSpan.textContent = path;
          delete fnSpan.dataset.incipitToolFullpath;
          truncatePathSpan(fnSpan);
          if (fnSpan.dataset.incipitToolFullpath !== path) {
            fnSpan.dataset.incipitToolFullpath = path;
          }
        }
        if (firstLine) fnSpan.dataset.incipitToolGrepLine = String(firstLine);
        else delete fnSpan.dataset.incipitToolGrepLine;

        if (fileOpener) {
          fnSpan.dataset.incipitToolGrepOpenable = '1';
          fnSpan.setAttribute('role', 'button');
          fnSpan.tabIndex = 0;
          bindGrepFilenameOpen(fnSpan, el);
        } else {
          delete fnSpan.dataset.incipitToolGrepOpenable;
          fnSpan.removeAttribute('role');
          fnSpan.removeAttribute('tabindex');
        }
      } else if (fnSpan) {
        fnSpan.remove();
      }

      // 2. aux span — simplify host's "N lines of output" to "N lines".
      const m = hostText.match(/(\d+)/);
      const auxText = m ? (m[1] + ' lines') : '';
      let auxSpan = insertHost.querySelector('[data-incipit-tool-fingerprint-aux]');
      if (auxText) {
        if (!auxSpan) {
          auxSpan = document.createElement('span');
          auxSpan.setAttribute('data-incipit-tool-fingerprint-aux', '');
          insertHost.appendChild(auxSpan);
        }
        if (auxSpan.textContent !== auxText) auxSpan.textContent = auxText;
      } else if (auxSpan) {
        auxSpan.remove();
      }

      // 3. chevron — reuses the chevron mask via `data-incipit-tool-chevron`,
      // independent of `data-incipit-tool-stats` (which is only created
      // when there's a toolBody).
      let chevSpan = insertHost.querySelector('[data-incipit-tool-grep-chevron]');
      if (!chevSpan) {
        chevSpan = document.createElement('span');
        chevSpan.setAttribute('data-incipit-tool-grep-chevron', '');
        chevSpan.setAttribute('data-incipit-tool-chevron', '');
        insertHost.appendChild(chevSpan);
      }

      // 4. expansion grid — IN row (the query) + OUT row (the lines count
      // text we hid from the summary). Mimics the host's toolBodyGrid
      // layout but uses our own attrs so no host class enters the cascade.
      const outText = resultText || hostText;
      let expSpan = el.querySelector('[data-incipit-tool-grep-expansion]');
      if (pattern || outText) {
        if (!expSpan) {
          expSpan = document.createElement('div');
          expSpan.setAttribute('data-incipit-tool-grep-expansion', '');
          if (summary.nextSibling) {
            summary.parentElement.insertBefore(expSpan, summary.nextSibling);
          } else {
            summary.parentElement.appendChild(expSpan);
          }
        }
        // Build/update grid rows. Idempotent: only writes textContent when
        // it differs to avoid every-frame DOM churn.
        let inLabel = expSpan.querySelector('[data-incipit-tool-grep-row="in"] [data-incipit-tool-grep-label]');
        let inContent = expSpan.querySelector('[data-incipit-tool-grep-row="in"] [data-incipit-tool-grep-content]');
        if (!inLabel) {
          const inRow = document.createElement('div');
          inRow.setAttribute('data-incipit-tool-grep-row', 'in');
          inLabel = document.createElement('div');
          inLabel.setAttribute('data-incipit-tool-grep-label', '');
          inLabel.textContent = legacyText('grep_in_label');
          inContent = document.createElement('div');
          inContent.setAttribute('data-incipit-tool-grep-content', '');
          inRow.appendChild(inLabel);
          inRow.appendChild(inContent);
          expSpan.appendChild(inRow);
        }
        const inText = path ? '"' + pattern + '" (in ' + path + ')' : '"' + pattern + '"';
        if (inContent.textContent !== inText) inContent.textContent = inText;

        let outLabel = expSpan.querySelector('[data-incipit-tool-grep-row="out"] [data-incipit-tool-grep-label]');
        let outContent = expSpan.querySelector('[data-incipit-tool-grep-row="out"] [data-incipit-tool-grep-content]');
        if (outText) {
          if (!outLabel) {
            const outRow = document.createElement('div');
            outRow.setAttribute('data-incipit-tool-grep-row', 'out');
            outLabel = document.createElement('div');
            outLabel.setAttribute('data-incipit-tool-grep-label', '');
            outLabel.textContent = legacyText('grep_out_label');
            outContent = document.createElement('div');
            outContent.setAttribute('data-incipit-tool-grep-content', '');
            outRow.appendChild(outLabel);
            outRow.appendChild(outContent);
            expSpan.appendChild(outRow);
          }
          applyGrepOutTruncation(outContent, outText);
        } else if (outLabel) {
          outLabel.parentElement.remove();
        }
      } else if (expSpan) {
        expSpan.remove();
      }

      // 5. click handler — toggles collapsed and animates both expansion
      // and (if present) host toolBody together. Re-uses `foldDuration`
      // for constant-speed timing.
      if (el.dataset.incipitToolBound !== '1') {
        el.addEventListener('click', evt => {
          const tgt = evt.target;
          if (tgt.closest && tgt.closest('[data-incipit-tool-grep-expansion]')) return;
          if (tgt.closest && tgt.closest('[data-incipit-tool-fullpath], [class*="filePath_"]')) return;
          evt.stopPropagation();
          const collapsed = el.dataset.incipitToolCollapsed === 'true';
          const expansion = el.querySelector('[data-incipit-tool-grep-expansion]');
          const tBody = el.querySelector('[class*="toolBody_"]');
          const targets = [];
          if (expansion) targets.push(expansion);
          if (tBody && tBody.children.length > 0) targets.push(tBody);
          if (!targets.length) {
            el.dataset.incipitToolCollapsed = collapsed ? 'false' : 'true';
            return;
          }
          if (collapsed) animateExpandTargets(el, targets);
          else           animateCollapseTargets(el, targets);
        });
        el.dataset.incipitToolBound = '1';
      }
    }

    // Path truncation — deep absolute paths in the tool summary's secondary
    // slot (`toolNameTextSecondary`, e.g. `C:\Users\...\tests\foo.py`) are
    // replaced with `…/parent/basename` so a long row stops overflowing the
    // chat viewport. Original is stashed on `data-incipit-tool-fullpath`
    // for the CSS hover tooltip to read via `attr()`.
    //
    // Idempotent across MO ticks: when our own `…`-prefixed form is still
    // in place we re-derive from the stored original; if the host swaps in
    // a new path, the `current != stored && !startsWith('…')` branch
    // rehydrates the source of truth.
    //
    // Intentionally skipped (each degrades to "leave text as-is"):
    //   - spans with element children (not a plain-text leaf)
    //   - content with no `/` or `\`, or any whitespace — catches Bash
    //     command text in the `Plaintext` variant of the same class family
    //   - paths with fewer than 3 segments (truncating `src/foo.py` would
    //     be longer than the original, and carries no useful context)
    function truncatePathSpan(pathSpan) {
      // If an ancestor already carries our fullpath attr, an outer
      // selector match already processed this path — skip to avoid
      // double-truncation (filePath nested inside toolNameTextSecondary).
      if (pathSpan.parentElement &&
          pathSpan.parentElement.closest('[data-incipit-tool-fullpath]')) {
        return;
      }
      // Host sometimes wraps the path text in `<a>` (for click-to-open) or
      // a nested `<span class="filePath_...">` layer. Walk down while
      // there's exactly one element child so we edit the true text leaf,
      // preserving any href / event handlers on the wrapper. If the DOM
      // branches, bail — mixing textContent into a multi-child host
      // structure would destroy adjacent siblings.
      let leaf = pathSpan;
      while (leaf.children.length === 1) {
        leaf = leaf.firstElementChild;
      }
      if (leaf.children.length > 0) return;

      const current = (leaf.textContent || '').trim();
      if (!current) return;

      // Store the fullpath attr on the outer `pathSpan`, not the leaf —
      // outer is usually a plain `<span>` (stable hover target, clean CSS
      // inheritance), while the leaf may be an `<a>` with existing
      // link-affordance rules that can conflict with `::after` rendering.
      const stored = pathSpan.dataset.incipitToolFullpath;
      const hostFresh = (stored && current.charCodeAt(0) === 0x2026) ? stored : current;

      let desired = hostFresh;
      let shouldStore = false;
      const looksLikePath =
        !/\s/.test(hostFresh) && (hostFresh.includes('/') || hostFresh.includes('\\'));
      if (looksLikePath) {
        const parts = hostFresh.split(/[\/\\]+/).filter(Boolean);
        if (parts.length >= 3) {
          const sep = hostFresh.includes('\\') ? '\\' : '/';
          desired = '\u2026' + sep + parts[parts.length - 2] + sep + parts[parts.length - 1];
          shouldStore = true;
        }
      }

      if (shouldStore) {
        if (pathSpan.dataset.incipitToolFullpath !== hostFresh) {
          pathSpan.dataset.incipitToolFullpath = hostFresh;
        }
      } else if (pathSpan.dataset.incipitToolFullpath) {
        delete pathSpan.dataset.incipitToolFullpath;
      }

      if (leaf.textContent !== desired) {
        leaf.textContent = desired;
      }
    }

    // Path tooltip portal.  A single `<div>` appended to `<body>`,
    // `position: fixed`, shown on mouseover of any
    // `[data-incipit-tool-fullpath]` anywhere in the subtree.
    //
    // Rationale: an in-line `::after` tooltip on the path span is subject
    // to any ancestor's `overflow: hidden` / `contain:` / stacking
    // context, any of which can silently clip or suppress it. The host
    // freely sets those on summary / toolUse / message wrappers. A
    // body-level fixed element sidesteps all of it — one clipping
    // boundary (the viewport) and one stacking context (the top of the
    // tree), both of which we control.
    //
    // Decoupling: zero reads or writes of host DOM beyond the
    // `data-incipit-tool-fullpath` attribute that truncatePathSpan has
    // already placed. Hover detection is delegated on `document.body`
    // scoped via `closest`; `scroll` / `resize` force-hide so a
    // re-layout never leaves the tooltip drifting over the wrong
    // anchor. An rAF loop runs only while visible, reposition + check
    // `body.contains(target)` so React re-renders auto-dismiss.
    let tipEl = null;
    let tipTextEl = null;
    let tipContextMenuEl = null;
    let tipContextMenuInfo = null;
    let tipTarget = null;
    let tipFullpath = '';
    let tipFileInfo = null;
    let tipRaf = 0;
    let tipHideTimer = 0;
    let tipShowTimer = 0;
    let tipPendingTarget = null;
    let tipPendingPath = '';
    let tipPendingProbe = null;
    let tipRevealSeq = 0;
    let tipRevealListenerBound = false;
    const tipRevealPending = new Map();
    let tipPathCopySeq = 0;
    let tipPathCopyListenerBound = false;
    const tipPathCopyPending = new Map();
    const BODY_LINK_SCOPE_SELECTOR =
      '[data-incipit-markdown-root], [data-incipit-message], [class*="root_"]';
    // Hover-intent dwell (user request, 2026-05-18): the popover only
    // appears after the pointer rests on a link for this long, so it does
    // not flash while the eye/cursor merely sweeps across links in prose.
    // Tunable; the click-to-open handoff is intentionally NOT gated by it.
    const TIP_SHOW_DELAY = 380;
    // Short close-grace for crossing the intentional 4px anchor↔popover gap.
    // 60ms is enough for ordinary mouse travel without making the tooltip
    // feel sticky after the pointer leaves.
    const TIP_HIDE_GRACE = 60;
    const TIP_PROBE_MOVE_TOLERANCE_PX = 4;

    function cancelScheduledHide() {
      if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = 0; }
    }
    function scheduleHide() {
      clearTipShowTimer();
      if (tipHideTimer) return;
      tipHideTimer = setTimeout(hideTip, TIP_HIDE_GRACE);
    }

    function clearTipShowTimer() {
      if (tipShowTimer) { clearTimeout(tipShowTimer); tipShowTimer = 0; }
      tipPendingTarget = null;
      tipPendingPath = '';
      tipPendingProbe = null;
    }

    function safeDecodeURIComponent(value) {
      try { return decodeURIComponent(value); } catch (_) { return value; }
    }

    function fileHrefToLocalPath(rawHref) {
      try {
        const url = new URL(rawHref);
        const host = safeDecodeURIComponent(url.hostname || '');
        let pathname = safeDecodeURIComponent(url.pathname || '');
        if (/^\/[A-Za-z]:\//.test(pathname)) {
          return pathname.slice(1).replace(/\//g, '\\');
        }
        if (host && host.toLowerCase() !== 'localhost') {
          const body = pathname.replace(/^\/+/, '');
          return '//' + host + (body ? '/' + body : '');
        }
        return pathname;
      } catch (_) {
        return null;
      }
    }

    function eventTargetElement(node) {
      if (!node) return null;
      return node.nodeType === 1 ? node : (node.parentElement || null);
    }

    function isExternalHref(raw) {
      if (!raw) return false;
      // Windows `C:\x` / `C:/x` is a filesystem path, not a URL scheme.
      if (/^[A-Za-z]:[\\/]/.test(raw)) return false;
      return /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:/i.test(raw);
    }

    function parseHrefLineLocation(hash) {
      const m = String(hash || '').match(/^#L?(\d+)(?:-L?(\d+))?$/i);
      if (!m) return undefined;
      const startLine = validLineNumber(m[1]);
      if (!startLine) return undefined;
      const endLine = validLineNumber(m[2]) || startLine;
      return { startLine, endLine };
    }

    function splitFileHref(rawHref) {
      let raw = String(rawHref || '').trim();
      if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
      if (raw.charAt(0) === '#') return null;
      if (isExternalHref(raw)) return null;

      let hash = '';
      const hashIndex = raw.indexOf('#');
      if (hashIndex !== -1) {
        hash = raw.slice(hashIndex);
        raw = raw.slice(0, hashIndex);
      }
      const queryIndex = raw.indexOf('?');
      if (queryIndex !== -1) raw = raw.slice(0, queryIndex);
      let decoded = false;
      if (/^file:/i.test(raw)) {
        raw = fileHrefToLocalPath(raw);
        if (!raw) return null;
        decoded = true;
      }
      raw = (decoded ? String(raw) : safeDecodeURIComponent(raw)).trim();
      if (!raw) return null;
      return {
        filePath: raw,
        location: parseHrefLineLocation(hash),
      };
    }

    function fileInfoFromToolEl(toolEl, pathText) {
      const filePath = String(pathText || '').trim();
      if (!filePath) return null;
      const spec = toolPathOpenSpecs.get(toolEl);
      const line = validLineNumber(toolEl.dataset && toolEl.dataset.incipitToolGrepLine);
      return {
        filePath: spec && spec.path ? spec.path : filePath,
        location: spec && spec.location ? spec.location : (line ? { startLine: line, endLine: line } : undefined),
      };
    }

    function tipHitFromTool(toolEl) {
      const p = toolEl && toolEl.dataset && toolEl.dataset.incipitToolFullpath;
      return p ? { target: toolEl, path: p, fileInfo: fileInfoFromToolEl(toolEl, p) } : null;
    }

    function tipHitFromLink(link) {
      if (!link) return null;
      // Use the *authored* href (getAttribute), never `link.href`. The
      // VSCode webview resolves relative anchors against its own
      // `vscode-webview://<id>/` origin, so `link.href` for a workspace
      // file ref like `data/theme.css#L1224` becomes a useless
      // `vscode-webview://.../data/theme.css#L1224`. The raw attribute is
      // the faithful value: the workspace-relative path the host maps
      // back on click, or, for true external links, the full URL.
      const raw = link.getAttribute('href') || '';
      if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
      return { target: link, path: raw, fileInfo: splitFileHref(raw) };
    }

    function cwdForFileAction() {
      try {
        const state = kernelGetHostState({ refresh: true, reason: 'link-file-action' });
        return state && typeof state.cwd === 'string' ? state.cwd : '';
      } catch (_) {
        // Keep file actions useful when the semantic bridge is degraded:
        // the legacy surface already owns a SessionState fiber fallback.
        try {
          const session = locateActiveSessionState();
          const cwd = session && session.cwd;
          if (cwd && typeof cwd === 'object' && typeof cwd.value === 'string') return cwd.value;
          if (typeof cwd === 'string') return cwd;
        } catch (__) {}
        return '';
      }
    }

    function sessionIdForFileAction() {
      try {
        const state = kernelGetHostState({ refresh: true, reason: 'link-file-action' });
        return state && typeof state.sessionId === 'string' ? state.sessionId : '';
      } catch (_) {
        return '';
      }
    }

    function setupTipRevealChannel() {
      if (tipRevealListenerBound) return;
      tipRevealListenerBound = true;
      window.addEventListener('message', evt => {
        const msg = evt && evt.data;
        if (!msg || msg.__incipit !== true || msg.type !== 'file_reveal_response') return;
        const pending = tipRevealPending.get(msg.requestId);
        if (!pending) return;
        tipRevealPending.delete(msg.requestId);
        const payload = msg.payload || {};
        if (payload.ok === false) pending.reject(new Error(payload.error || 'Could not open containing folder.'));
        else pending.resolve(payload);
      });
    }

    function requestOpenContainingFolder(info) {
      if (!info || !info.filePath) return Promise.reject(new Error('No file path to reveal.'));
      setupTipRevealChannel();
      const api = getIncipitVsCodeApi();
      if (!api || typeof api.postMessage !== 'function') {
        return Promise.reject(new Error('Could not reach the VS Code webview channel.'));
      }
      const requestId = 'reveal-' + (++tipRevealSeq).toString(36);
      const message = {
        __incipit: true,
        type: 'file_reveal_request',
        requestId,
        filePath: info.filePath,
        cwd: cwdForFileAction(),
        sessionId: sessionIdForFileAction(),
      };
      return new Promise((resolve, reject) => {
        tipRevealPending.set(requestId, { resolve, reject });
        try {
          api.postMessage(message);
        } catch (error) {
          tipRevealPending.delete(requestId);
          reject(error);
          return;
        }
        setTimeout(() => {
          const pending = tipRevealPending.get(requestId);
          if (!pending) return;
          tipRevealPending.delete(requestId);
          pending.reject(new Error('Open containing folder request timed out.'));
        }, 6000);
      });
    }

    function ensureTipEl() {
      if (tipEl && document.body && document.body.contains(tipEl)) return tipEl;
      tipEl = document.createElement('div');
      tipEl.setAttribute('data-incipit-path-tooltip', '');
      tipTextEl = document.createElement('span');
      tipTextEl.setAttribute('data-incipit-path-tooltip-text', '');
      tipEl.addEventListener('mouseenter', cancelScheduledHide);
      tipEl.addEventListener('mouseleave', scheduleHide);
      tipEl.appendChild(tipTextEl);
      if (document.body) document.body.appendChild(tipEl);
      return tipEl;
    }

    function setupTipPathCopyChannel() {
      if (tipPathCopyListenerBound) return;
      tipPathCopyListenerBound = true;
      window.addEventListener('message', evt => {
        const msg = evt && evt.data;
        if (!msg || msg.__incipit !== true || msg.type !== 'file_path_copy_response') return;
        const pending = tipPathCopyPending.get(msg.requestId);
        if (!pending) return;
        tipPathCopyPending.delete(msg.requestId);
        const payload = msg.payload || {};
        if (payload.ok === false) pending.reject(new Error(payload.error || 'Could not resolve file path.'));
        else pending.resolve(payload);
      });
    }

    function requestResolvedFilePaths(info) {
      if (!info || !info.filePath) return Promise.reject(new Error('No file path to copy.'));
      setupTipPathCopyChannel();
      const api = getIncipitVsCodeApi();
      if (!api || typeof api.postMessage !== 'function') {
        return Promise.reject(new Error('Could not reach the VS Code webview channel.'));
      }
      const requestId = 'path-copy-' + (++tipPathCopySeq).toString(36);
      const message = {
        __incipit: true,
        type: 'file_path_copy_request',
        requestId,
        filePath: info.filePath,
        cwd: cwdForFileAction(),
        sessionId: sessionIdForFileAction(),
      };
      return new Promise((resolve, reject) => {
        tipPathCopyPending.set(requestId, { resolve, reject });
        try {
          api.postMessage(message);
        } catch (error) {
          tipPathCopyPending.delete(requestId);
          reject(error);
          return;
        }
        setTimeout(() => {
          const pending = tipPathCopyPending.get(requestId);
          if (!pending) return;
          tipPathCopyPending.delete(requestId);
          pending.reject(new Error('Path copy request timed out.'));
        }, 6000);
      });
    }

    function copyResolvedPathForFileInfo(kind, info) {
      requestResolvedFilePaths(info).then(payload => {
        const text = kind === 'absolute' ? payload.absolutePath : payload.relativePath;
        if (!text) {
          throw new Error(kind === 'absolute'
            ? 'Could not resolve absolute path.'
            : 'Could not resolve relative path for this workspace.');
        }
        return copyText(text);
      }).catch(error => {
        try { console.warn('[incipit] failed to copy path:', error); } catch (_) {}
        showTranscriptToast(kind === 'absolute' ? legacyText('could_not_copy_absolute_path') : legacyText('could_not_copy_relative_path'), 'error');
      });
    }

    function closeTipContextMenu() {
      if (!tipContextMenuEl) return;
      tipContextMenuEl.removeAttribute('data-incipit-path-context-menu-visible');
      tipContextMenuInfo = null;
      document.removeEventListener('mousedown', handleTipContextMenuDocumentMouseDown, true);
      document.removeEventListener('keydown', handleTipContextMenuKeyDown, true);
      window.removeEventListener('scroll', closeTipContextMenu, true);
      window.removeEventListener('resize', closeTipContextMenu);
    }

    function handleTipContextMenuDocumentMouseDown(evt) {
      const target = eventTargetElement(evt.target);
      if (tipContextMenuEl && target && tipContextMenuEl.contains(target)) return;
      closeTipContextMenu();
    }

    function handleTipContextMenuKeyDown(evt) {
      if (evt.key !== 'Escape') return;
      evt.preventDefault();
      closeTipContextMenu();
    }

    function makeTipContextMenuItem(labelText, iconSvg, action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-incipit-path-context-menu-item', '');
      btn.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.setAttribute('data-incipit-action-dropdown-icon', '');
      icon.innerHTML = iconSvg;
      const label = document.createElement('span');
      label.setAttribute('data-incipit-action-dropdown-label', '');
      label.textContent = labelText;
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', evt => {
        evt.preventDefault();
        evt.stopPropagation();
        const info = tipContextMenuInfo;
        closeTipContextMenu();
        if (info && typeof action === 'function') action(info, btn);
      });
      return btn;
    }

    function ensureTipContextMenuEl() {
      if (tipContextMenuEl && document.body && document.body.contains(tipContextMenuEl)) return tipContextMenuEl;
      tipContextMenuEl = document.createElement('div');
      tipContextMenuEl.setAttribute('data-incipit-path-context-menu', '');
      tipContextMenuEl.setAttribute('role', 'menu');
      tipContextMenuEl.addEventListener('contextmenu', evt => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      tipContextMenuEl.appendChild(makeTipContextMenuItem(legacyText('open_in_file_explorer'), FOLDER_ICON_SVG, info => {
        requestOpenContainingFolder(info).catch(error => {
          try { console.warn('[incipit] failed to open in file explorer:', error); } catch (_) {}
          showTranscriptToast(legacyText('could_not_open_in_file_explorer'), 'error');
        });
      }));
      tipContextMenuEl.appendChild(makeTipContextMenuItem(legacyText('copy_relative_path'), COPY_ICON_SVG, info => {
        copyResolvedPathForFileInfo('relative', info);
      }));
      tipContextMenuEl.appendChild(makeTipContextMenuItem(legacyText('copy_absolute_path'), COPY_ICON_SVG, info => {
        copyResolvedPathForFileInfo('absolute', info);
      }));
      if (document.body) document.body.appendChild(tipContextMenuEl);
      return tipContextMenuEl;
    }

    function positionTipContextMenu(evt) {
      if (!tipContextMenuEl || !evt) return;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const w = tipContextMenuEl.offsetWidth || 236;
      const h = tipContextMenuEl.offsetHeight || 112;
      const left = Math.max(4, Math.min(evt.clientX, vw - w - 4));
      const top = Math.max(4, Math.min(evt.clientY, vh - h - 4));
      tipContextMenuEl.style.left = left + 'px';
      tipContextMenuEl.style.top = top + 'px';
    }

    function openTipContextMenu(hit, evt) {
      if (!hit || !hit.fileInfo || !hit.fileInfo.filePath || !evt) return false;
      closeTipContextMenu();
      hideTip();
      clearTipShowTimer();
      tipContextMenuInfo = hit.fileInfo;
      const menu = ensureTipContextMenuEl();
      menu.setAttribute('data-incipit-path-context-menu-visible', '1');
      positionTipContextMenu(evt);
      document.addEventListener('mousedown', handleTipContextMenuDocumentMouseDown, true);
      document.addEventListener('keydown', handleTipContextMenuKeyDown, true);
      window.addEventListener('scroll', closeTipContextMenu, { capture: true, passive: true });
      window.addEventListener('resize', closeTipContextMenu);
      return true;
    }

    function bodyLinkScopeFor(node) {
      const el = eventTargetElement(node);
      if (!el || !el.closest) return null;
      const scope = el.closest(BODY_LINK_SCOPE_SELECTOR);
      if (!scope) return null;
      const incipitTagged = scope.hasAttribute(ATTR.markdownRoot) || scope.hasAttribute(ATTR.message);
      const assistantMarkdownFallback = !incipitTagged &&
        scope.matches &&
        scope.matches('[class*="root_"]') &&
        !!findAssistantActionHost(scope);
      if (!incipitTagged && !assistantMarkdownFallback) return null;
      if (scope.closest(SEL.userMessageContainer) ||
          scope.closest(SEL.userBubble) ||
          scope.closest(SEL.toolUse) ||
          scope.closest(SEL.thinking) ||
          scope.closest(SEL.thinkingSummary) ||
          scope.closest(SEL.thinkingContent) ||
          scope.closest('[class*="userMessageContainer"]') ||
          scope.closest('[class*="userMessage_"]') ||
          scope.closest('[class*="toolUse_"]') ||
          scope.closest('[class*="thinking"]')) return null;
      return scope;
    }

    function closestBodyLink(node) {
      const el = eventTargetElement(node);
      const link = el && el.closest ? el.closest('a[href]') : null;
      return link && bodyLinkScopeFor(link) ? link : null;
    }

    function pointInsideAnyClientRect(el, x, y) {
      if (!el || !el.getClientRects) return false;
      const rects = el.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
      return false;
    }

    function bodyLinkFromPoint(node, evt) {
      if (!evt || !Number.isFinite(evt.clientX) || !Number.isFinite(evt.clientY)) return null;
      const direct = typeof document.elementFromPoint === 'function'
        ? closestBodyLink(document.elementFromPoint(evt.clientX, evt.clientY))
        : null;
      if (direct) return direct;
      const scope = bodyLinkScopeFor(node);
      if (!scope || !scope.querySelectorAll) return null;
      const links = scope.querySelectorAll('a[href]');
      for (let i = 0; i < links.length; i++) {
        if (pointInsideAnyClientRect(links[i], evt.clientX, evt.clientY)) return links[i];
      }
      return null;
    }

    function snapshotTipEvent(evt) {
      if (!evt || !Number.isFinite(evt.clientX) || !Number.isFinite(evt.clientY)) return null;
      return {
        target: evt.target || null,
        clientX: evt.clientX,
        clientY: evt.clientY,
      };
    }

    function samePendingProbe(snapshot) {
      if (!tipPendingProbe || !snapshot) return false;
      if (tipPendingProbe.target !== snapshot.target) return false;
      return Math.abs(tipPendingProbe.clientX - snapshot.clientX) <= TIP_PROBE_MOVE_TOLERANCE_PX &&
        Math.abs(tipPendingProbe.clientY - snapshot.clientY) <= TIP_PROBE_MOVE_TOLERANCE_PX;
    }

    function resolveTipFast(node, evt) {
      const el = eventTargetElement(node);
      if (!el || !el.closest) return null;
      const toolEl = el.closest('[data-incipit-tool-fullpath]');
      if (toolEl) return tipHitFromTool(toolEl);
      const link = closestBodyLink(el);
      if (link) return tipHitFromLink(link);
      if (evt && Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY) &&
          typeof document.elementFromPoint === 'function') {
        return tipHitFromLink(closestBodyLink(document.elementFromPoint(evt.clientX, evt.clientY)));
      }
      return null;
    }

    // Resolve a hovered node to its tooltip anchor + the full text to show
    // and copy. Two read-only sources, never host chrome:
    //   1. tool rows: the `data-incipit-tool-fullpath` attr truncatePathSpan
    //      already stamped.
    //   2. assistant body links: scoped strictly to incipit's own markdown /
    //      message roots, exposing the resolved `href` so a markdown
    //      `[text](url)` link reveals (and can copy) its real destination.
    // Hover remains read-only; the separate click handler below only
    // handles file hrefs when it can delegate to the host's fileOpener.
    function resolveTip(node, evt) {
      const el = eventTargetElement(node);
      if (!el || !el.closest) return null;
      const toolEl = el.closest('[data-incipit-tool-fullpath]');
      if (toolEl) return tipHitFromTool(toolEl);
      const link = closestBodyLink(el) || bodyLinkFromPoint(el, evt);
      return tipHitFromLink(link);
    }

    function armTipShow(hit, snapshot) {
      cancelScheduledHide();
      clearTipShowTimer();
      tipPendingTarget = hit ? hit.target : null;
      tipPendingPath = hit ? hit.path : '';
      tipPendingProbe = snapshot || null;
      tipShowTimer = setTimeout(() => {
        const resolved = hit || (tipPendingProbe ? resolveTip(tipPendingProbe.target, tipPendingProbe) : null);
        tipShowTimer = 0;
        tipPendingTarget = null;
        tipPendingPath = '';
        tipPendingProbe = null;
        if (resolved) showTip(resolved.target, resolved.path, resolved.fileInfo);
      }, TIP_SHOW_DELAY);
    }

    function handleTipHover(evt) {
      const hit = resolveTipFast(evt.target, evt);
      if (hit) {
        // Already shown for this exact anchor, or a reveal is already
        // counting down for it: let the dwell accumulate, don't restart.
        if (hit.target === tipTarget && hit.path === tipFullpath) {
          cancelScheduledHide();
          return;
        }
        if (hit.target === tipPendingTarget && hit.path === tipPendingPath && tipShowTimer) return;
        armTipShow(hit, snapshotTipEvent(evt));
        return;
      }
      // Once the popover is visible, no-hit mousemove means the pointer is
      // leaving the anchor/menu affordance. Schedule one short close-grace:
      // enough to cross the 4px gap, not enough to feel sticky.
      if (tipTarget) {
        const targetEl = eventTargetElement(evt.target);
        if (tipEl && targetEl && tipEl.contains(targetEl)) {
          cancelScheduledHide();
          return;
        }
        scheduleHide();
        return;
      }
      const snapshot = snapshotTipEvent(evt);
      if (!snapshot) return;
      // Full coordinate fallback can need a link-list scan plus rect reads for
      // delayed markdown-root tagging/text-node targets. Keep that off the
      // mousemove hot path: arm one dwell probe and do the heavier scan only
      // if the pointer truly rests.
      if (tipShowTimer && !tipPendingTarget && samePendingProbe(snapshot)) return;
      armTipShow(null, snapshot);
    }

    function positionTip() {
      if (!tipEl || !tipTarget) return;
      const rect = tipTarget.getBoundingClientRect();
      const h = tipEl.offsetHeight;
      const above = rect.top >= h + 8;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const w = tipEl.offsetWidth;
      const left = Math.max(4, Math.min(rect.left, vw - w - 4));
      tipEl.style.left = left + 'px';
      tipEl.style.top = (above ? rect.top - h - 4 : rect.bottom + 4) + 'px';
      tipEl.dataset.incipitPathTooltipPlacement = above ? 'above' : 'below';
    }

    function tickTip() {
      if (!tipTarget) { tipRaf = 0; return; }
      if (!document.body || !document.body.contains(tipTarget)) { hideTip(); return; }
      positionTip();
      tipRaf = requestAnimationFrame(tickTip);
    }

    function showTip(target, fullpath, fileInfo) {
      if (!fullpath) return;
      const el = ensureTipEl();
      tipTarget = target;
      tipFullpath = fullpath;
      tipFileInfo = fileInfo || null;
      tipTextEl.textContent = fullpath;
      el.setAttribute('data-incipit-path-tooltip-visible', '1');
      if (tipRaf) cancelAnimationFrame(tipRaf);
      tipRaf = requestAnimationFrame(tickTip);
    }

    function hideTip() {
      cancelScheduledHide();
      clearTipShowTimer();
      if (!tipEl) return;
      tipEl.removeAttribute('data-incipit-path-tooltip-visible');
      tipTarget = null;
      tipFullpath = '';
      tipFileInfo = null;
      if (tipRaf) { cancelAnimationFrame(tipRaf); tipRaf = 0; }
    }

    function bindBodyLinkOpen() {
      if (document.body.dataset.incipitLinkOpenBound === '1') return;
      document.body.dataset.incipitLinkOpenBound = '1';
      // User decision, 2026-05-18: file links in assistant markdown should
      // open in VS Code on the link itself; the tooltip's More menu is only
      // for revealing the file in its containing folder. This is a narrow file-href
      // click handoff to the host's own `context.fileOpener.open`, not a
      // markdown re-render or a generic link interceptor; external links and
      // heading anchors keep the host/browser behavior.
      document.body.addEventListener('click', evt => {
        const link = closestBodyLink(evt.target) || bodyLinkFromPoint(evt.target, evt);
        if (!link) return;
        const info = splitFileHref(link.getAttribute('href') || '');
        if (!info || !info.filePath) return;
        const opener = readHostFileOpener(link);
        if (!opener) return;
        evt.preventDefault();
        evt.stopPropagation();
        try {
          opener.open(info.filePath, info.location || undefined);
        } catch (error) {
          try { console.warn('[incipit] failed to open markdown file link:', error); } catch (_) {}
        }
      }, true);
    }

    function handleTipContextMenu(evt) {
      const hit = resolveTipFast(evt.target, evt) || resolveTip(evt.target, evt);
      if (!hit || !hit.fileInfo || !hit.fileInfo.filePath) return;
      evt.preventDefault();
      evt.stopPropagation();
      openTipContextMenu(hit, evt);
    }

    document.body.addEventListener('mouseover', handleTipHover, true);
    // Mouseover is not enough for assistant body links: Chromium/React can
    // deliver the first event against a text node or an untagged parent while
    // the markdown root is being decorated. Mousemove keeps hover detection
    // tied to the actual pointer coordinates, so a stable hover over the
    // visible link still arms the dwell timer.
    document.body.addEventListener('mousemove', handleTipHover, { capture: true, passive: true });
    // Right-click file actions are a separate sticky surface, not a child of
    // the hover tooltip. Mouse movement should never dismiss it; ordinary
    // clicks outside it and successful item clicks do.
    document.body.addEventListener('contextmenu', handleTipContextMenu, true);
    document.body.addEventListener('mouseout', evt => {
      const to = evt.relatedTarget;
      // Pointer left the anchor before the dwell completed → cancel the
      // pending reveal so it never pops behind the cursor. A move that
      // stays inside the same pending anchor (child→child) keeps counting.
      if ((tipPendingTarget &&
          !(to && tipPendingTarget.contains && tipPendingTarget.contains(to))) ||
          (!tipPendingTarget && tipPendingProbe)) {
        clearTipShowTimer();
      }
      if (!tipTarget) return;
      const hit = resolveTip(evt.target);
      if (!hit || hit.target !== tipTarget) return;
      // Moving deeper into the anchor, or onto the popover itself, must
      // not dismiss — the popover's own mouseleave handles that case.
      if (to && (tipTarget.contains(to) || (tipEl && tipEl.contains(to)))) return;
      scheduleHide();
    }, true);
    window.addEventListener('scroll', hideTip, { capture: true, passive: true });
    window.addEventListener('resize', hideTip);
    bindBodyLinkOpen();

    // Idempotent: safe to call repeatedly on the same element. React may
    // re-render the summary subtree (blowing away our stats span) or
    // update the tool-use props mid-stream (so the stats numbers need
    // refreshing), and each MO tick retries every toolUse node.
    //
    // Tools without a `toolBody_` child (e.g. Read, Grep when they have no
    // expandable output) are left untouched — there is nothing to fold,
    // so showing a chevron would be a lie.
    //
    // Click-to-toggle is wired on the toolUse root via event delegation
    // with two skip rules:
    //   - click inside the diff body: user is interacting with the diff,
    //     do not collapse under them.
    //   - click on the filename path (`toolNameTextSecondary`): preserve
    //     text-selection for the filename, per user request.
    // Everything else in the row (tool label, whitespace, +N / -M,
    // chevron) toggles the fold.
    function decorateToolUse(el) {
      // Path truncation runs regardless of fiber/status — it is a pure
      // display concern and should apply to failed / pending calls too.
      const summary = el.querySelector('[class*="toolSummary"]');
      if (summary) {
        summary
          .querySelectorAll('[class*="toolNameTextSecondary"], [class*="filePath"]')
          .forEach(truncatePathSpan);
      }

      // Grep single-line layout. Runs BEFORE the toolBody early-return
      // because the host renders Grep without a `toolBody_` container in
      // many cases (short outputs in particular) — yet still emits two
      // stacked fingerprint nodes (`toolNameTextSecondary` + standalone
      // `secondaryLine_*` div). We compress those two rows into one even
      // when there's no body to fold. Identification is fiber-based, no
      // dependency on host class names.
      const grepData = readToolUseBlock(el);
      decorateToolFilePaths(el, summary, grepData);
      handleGrepAuxLayout(el, summary, grepData);
      // Grep is fully self-contained inside `handleGrepAuxLayout` — it
      // owns chevron, click handler, expansion div, and animation. The
      // mainline flow below would otherwise inject its own stats span,
      // bind a second click handler, and force `collapsed=true` reset
      // every frame, all of which would fight the Grep takeover.
      if (grepData && grepData.block && grepData.block.name === 'Grep') return;

      // Skip tools with no expandable body. Claude Code emits `toolBody_`
      // for Edit / Write / Bash / TodoWrite etc. but leaves it empty for
      // Read / Grep / Glob when the host has nothing to show below the
      // summary. Adding a chevron to those would lie about expandability.
      const body = el.querySelector('[class*="toolBody_"]');
      if (!body || body.children.length === 0) return;

      const data = grepData;
      if (!data) return;
      // Blacklist only the terminal failure states. An allowlist on 'success'
      // would silently break if Claude Code introduces a new status name
      // (e.g. 'succeeded', 'ok', 'completed') in a minor version — stats and
      // the chevron would disappear across the board for no visible reason.
      if (data.status === 'error' || data.status === 'pending') return;

      if (!summary) return;

      // Append stats inside the same inline host as the tool name, not as a
      // sibling of the outer title wrapper. The host summary is a flex row,
      // and some tools (Agent / Task-like rows) wrap name + secondary text in
      // an inner block div; landing after that block pushes the chevron onto a
      // second line. The inline host keeps name, fingerprint, stats, chevron
      // in one text flow.
      const titleWrap = summary.firstElementChild;
      if (!titleWrap) return;

      const stats = computeStatsCached(data.block);
      const useIncipitDiff = !!incipitDiffPayload(data.block);
      if (useIncipitDiff) {
        ensureWriteDiffBody(el, body, data.block, stats);
      } else {
        cleanupWriteDiffBody(el, body);
        decorateInlineDiffHeader(body, data.block, stats);
        // Generic IN/OUT truncation for tools using the host's
        // `toolBodyGrid` template. Edit/MultiEdit/Write use incipit's own
        // diff island when their tool input is readable, so they bypass
        // this. Grep already returned.
        // Idempotent across re-decorates.
        const grid = body.querySelector('[class*="toolBodyGrid"]');
        if (grid) applyToolBodyTruncation(grid, data.block.name);
      }

      if (el.dataset.incipitToolBound !== '1') {
        el.addEventListener('click', evt => {
          const tgt = evt.target;
          if (tgt.closest && tgt.closest('[class*="toolBody_"]')) return;
          // Only skip on actual file paths, not on every tool's secondary
          // span — host shares the `toolNameTextSecondary*` class family
          // between Edit/Write paths and Bash/MCP fingerprints.
          if (tgt.closest && tgt.closest('[data-incipit-tool-fullpath], [class*="filePath_"]')) return;
          evt.stopPropagation();
          const collapsed = el.dataset.incipitToolCollapsed === 'true';
          const body = el.querySelector('[class*="toolBody_"]');
          if (!body) {
            el.dataset.incipitToolCollapsed = collapsed ? 'false' : 'true';
            return;
          }
          if (collapsed) animateExpandBody(el, body);
          else           animateCollapseBody(el, body);
        });
        el.dataset.incipitToolBound = '1';
        if (!el.dataset.incipitToolCollapsed) {
          snapInitialCollapse(el);
        }
      }

      // Granular create-once / textContent-only-on-change DOM updates.
      // `innerHTML =` would wipe attributes that other passes (math_rewriter
      // tagging, host_probe dataset writes) have layered onto our spans,
      // and since those passes immediately re-add them the resulting
      // attribute churn would flip `innerHTML !== html` back to true
      // every frame and spin up a 60-fps rebuild loop.
      const inlineHost = findToolSummaryInlineHost(summary, titleWrap);
      let statsEl = summary.querySelector('[data-incipit-tool-stats]');
      let addedSpan, removedSpan, chevronSpan;
      if (!statsEl) {
        statsEl = document.createElement('span');
        statsEl.setAttribute('data-incipit-tool-stats', '');
        addedSpan = document.createElement('span');
        addedSpan.setAttribute('data-incipit-tool-added', '');
        removedSpan = document.createElement('span');
        removedSpan.setAttribute('data-incipit-tool-removed', '');
        chevronSpan = document.createElement('span');
        chevronSpan.setAttribute('data-incipit-tool-chevron', '');
        statsEl.appendChild(addedSpan);
        statsEl.appendChild(removedSpan);
        statsEl.appendChild(chevronSpan);
        inlineHost.appendChild(statsEl);
      } else {
        if (inlineHost && statsEl.parentElement !== inlineHost) {
          inlineHost.appendChild(statsEl);
        }
        addedSpan = statsEl.querySelector('[data-incipit-tool-added]');
        removedSpan = statsEl.querySelector('[data-incipit-tool-removed]');
        chevronSpan = statsEl.querySelector('[data-incipit-tool-chevron]');
      }

      if (stats) {
        const wantAdded = '+' + stats.added;
        const wantRemoved = '\u2212' + stats.removed;
        if (addedSpan.textContent !== wantAdded) addedSpan.textContent = wantAdded;
        if (removedSpan.textContent !== wantRemoved) removedSpan.textContent = wantRemoved;
        if (addedSpan.style.display === 'none') addedSpan.style.display = '';
        if (removedSpan.style.display === 'none') removedSpan.style.display = '';
        el.dataset.incipitToolHasStats = '1';
      } else {
        // Non-Edit/Write tools: hide the +/- spans but keep them in place
        // and keep the chevron visible.
        if (addedSpan.style.display !== 'none') addedSpan.style.display = 'none';
        if (removedSpan.style.display !== 'none') removedSpan.style.display = 'none';
        delete el.dataset.incipitToolHasStats;
      }

      // Fingerprint fallback + collapsed/expanded label swap.
      // Edit/MultiEdit/Write own the row with `+N -M` and never get this.
      // For everything else with a body:
      //   - Collapsed: show the host's secondaryLine if it has text; if it
      //     doesn't, inject our own one-liner from `block.input`.
      //   - Expanded: hide both host secondaryLine and our fingerprint, show
      //     a static label ('command' / 'pattern' / 'query' / ...) instead.
      // CSS owns all visibility — JS only writes textContent and inserts
      // spans, so there is no per-frame reflow churn from this block.
      const label = stats ? null : pickLabelFor(data.block.name);
      let fpSpan = titleWrap.querySelector('[data-incipit-tool-fingerprint]');
      let labelSpan = titleWrap.querySelector('[data-incipit-tool-fingerprint-label]');

      if (label) {
        // Host writes the fingerprint into one of two class families:
        //   - `secondaryLine_*` (Grep, MCP-style "[op] args")
        //   - `toolNameTextSecondary*` / `toolNameTextSecondaryPlaintext_*`
        //     (Bash description, Edit/Write file path)
        // Match both so we never inject a duplicate next to a host-provided one.
        const hostSec = summary.querySelector(
          '[class*="secondaryLine_"], [class*="toolNameTextSecondary"]'
        );
        const hostHasText = !!(hostSec && hostSec.textContent && hostSec.textContent.trim());
        if (hostHasText) {
          // Host already wrote a fingerprint (e.g. Bash description, Grep
          // pattern, MCP `[op] args`). Don't overwrite — collapsed state
          // truncates it via CSS, expanded state lets it run full.
          if (fpSpan) { fpSpan.remove(); fpSpan = null; }
          if (labelSpan) { labelSpan.remove(); labelSpan = null; }
        } else {
          // Fallback: synthesize a one-liner fingerprint from input, swap to
          // the abstract label on expand.
          const fpText = pickFallbackFingerprint(data.block.name, data.block.input);
          if (fpText) {
            if (!fpSpan) {
              fpSpan = document.createElement('span');
              fpSpan.setAttribute('data-incipit-tool-fingerprint', '');
            }
            if (fpSpan.parentElement !== inlineHost) {
              inlineHost.insertBefore(fpSpan, statsEl);
            }
            if (fpSpan.textContent !== fpText) fpSpan.textContent = fpText;
          } else if (fpSpan) {
            fpSpan.remove(); fpSpan = null;
          }
          if (!labelSpan) {
            labelSpan = document.createElement('span');
            labelSpan.setAttribute('data-incipit-tool-fingerprint-label', '');
          }
          if (labelSpan.parentElement !== inlineHost) {
            inlineHost.insertBefore(labelSpan, statsEl);
          }
          if (labelSpan.textContent !== label) labelSpan.textContent = label;
        }
      } else {
        if (fpSpan) fpSpan.remove();
        if (labelSpan) labelSpan.remove();
      }
    }

    // Cache `computeStats` results keyed on the fiber block object ref. React
    // hands us the same `block` reference across renders that didn't actually
    // change the tool input, so the LCS only runs on truly new blocks. When
    // the host swaps the prop (mid-stream input update), the new ref naturally
    // misses cache and recomputes.
    const statsCache = new WeakMap();
    function computeStatsCached(block) {
      if (!block) return null;
      if (statsCache.has(block)) return statsCache.get(block);
      const stats = computeStats(block);
      statsCache.set(block, stats);
      return stats;
    }

    // `pendingToolUseRoots` stores the actual toolUse elements that need
    // (re)decoration this frame, not arbitrary mutation roots. The mutation
    // handler walks each added subtree to figure out which toolUse(s) are
    // affected — the previous implementation always re-scanned the entire
    // document body every animation frame, which scaled poorly with long
    // sessions.
    const pendingToolUseRoots = new Set();
    let rescanScheduled = false;
    function scheduleRescan() {
      if (rescanScheduled) return;
      rescanScheduled = true;
      requestAnimationFrame(() => {
        rescanScheduled = false;
        if (!pendingToolUseRoots.size) return;
        const tools = Array.from(pendingToolUseRoots);
        pendingToolUseRoots.clear();
        for (const t of tools) {
          if (!t.isConnected) continue;
          try { decorateToolUse(t); }
          catch (e) { try { console.warn('[incipit] decorateToolUse failed:', e); } catch (_) {} }
        }
      });
    }

    function enqueueAffectedToolUses(node, targetInsideToolUse) {
      if (!node || node.nodeType !== 1) return false;
      let queued = false;
      // Case A: the added subtree IS a toolUse, or sits INSIDE one.
      // Covers React rebuilding the summary subtree mid-stream — the rebuilt
      // children come in as added nodes whose closest toolUse needs to be
      // re-decorated because our injected stats span was wiped.
      if (targetInsideToolUse) {
        const ancestor = node.closest && node.closest('[class*="toolUse_"]');
        if (ancestor) {
          pendingToolUseRoots.add(ancestor);
          queued = true;
        }
      }
      if (elementClassText(node).indexOf('toolUse_') !== -1) {
        pendingToolUseRoots.add(node);
        queued = true;
      }
      // Case B: the added subtree CONTAINS toolUse descendants (e.g. a fresh
      // assistant message landing with a tool call inside).
      if (node.firstElementChild && node.querySelectorAll) {
        const inners = node.querySelectorAll('[class*="toolUse_"]');
        for (const t of inners) {
          pendingToolUseRoots.add(t);
          queued = true;
        }
      }
      return queued;
    }

    // Local body observer is the primary path again. An earlier attempt
    // funnelled tool-use mounts through a kernel `mutationBus` event, but
    // that observer ran six selector tests per added node for every
    // streaming token — a much higher per-mutation cost than this loop,
    // which only walks `addedNodes` and does a single `closest`. The
    // `pendingToolUseRoots` Set keeps the scan amortised per RAF.
    const mo = new MutationObserver(muts => {
      let dirty = false;
      for (let i = 0; i < muts.length; i++) {
        const m = muts[i];
        if (m.type !== 'childList' || !m.addedNodes.length) continue;
        if (mutationInsideFocusedEditor(m)) continue;
        const targetInsideToolUse = !!(
          m.target &&
          (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('[class*="toolUse_"]')
        );
        for (const node of m.addedNodes) {
          if (enqueueAffectedToolUses(node, targetInsideToolUse)) dirty = true;
        }
      }
      if (dirty && pendingToolUseRoots.size) scheduleRescan();
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Seed the queue with everything already on the page so the first frame
    // decorates the same set the old `scheduleRescan()` initial call did.
    const initialRoot = document.querySelector(SEL.messagesContainer) ||
      document.querySelector('[class*="messagesContainer_"]') ||
      document.body;
    if (initialRoot) {
      const initial = initialRoot.querySelectorAll('[class*="toolUse_"]');
      for (const t of initial) pendingToolUseRoots.add(t);
      scheduleRescan();
    }
  }

  function flushDeferredCodeHighlightsIfReady() {
    const typography = globalThis.__incipitTypography;
    if (typography && typeof typography.flushDeferredCodeHighlights === 'function') {
      return typography.flushDeferredCodeHighlights();
    }
    return false;
  }

  function exposeLegacyHooks() {
    const hooks = {
      conversationIsBusy,
      noteTranscriptActionMutation,
      scanAndAddCopyButtons,
      sweepStreamingDisableState,
    };
    globalThis.__incipitLegacyHooks = hooks;
    const typography = globalThis.__incipitTypography;
    if (typography && typeof typography.configure === 'function') {
      typography.configure(hooks);
    }
    if (typography && typeof typography.scanCopyButtons === 'function') {
      const transcriptRoot = document.querySelector(SEL.messagesContainer) ||
        document.querySelector('[class*="messagesContainer_"]') ||
        document.body;
      typography.scanCopyButtons(transcriptRoot, { assistantActions: false });
    }
    noteTranscriptActionMutation();
    reportHealth('legacy.hooks', 'ok');
  }

  function assertForkRewindReady() {
    if (typeof forkFromUser !== 'function' ||
        typeof rewindOnlyFromUser !== 'function' ||
        typeof forkWithRewindFromUser !== 'function') {
      throw new Error('fork/rewind actions are not available');
    }
  }

  function init() {
    reportHealth('legacy', 'starting');
    log('Initializing legacy interaction module...');
    setupRuntimeBusyProbe();
    const legacyContext = {
      reportHealth,
      preloadEffortBrainIcons,
      exposeLegacyHooks,
      setupToolFold,
      setupDiffSideBars,
      setupBusyStateObserver,
      setupFileDragReferenceHint,
      setupUserBubbleNativeActionSuppression,
      setupDeferredNextMessageQueue,
      setupChangeReviewFileReview,
      setupAskRequestRefinement,
      setupCommandMenuTransientSelectionCleanup,
      setupCustomModelPicker,
      setupTranscriptActionDebugTools,
      assertForkRewindReady,
    };
    initLegacyIdentity(legacyContext);
    initLegacyTranscriptActions(legacyContext);
    initLegacyToolFold(legacyContext);
    initLegacyDiffIsland(legacyContext);
    initLegacyForkRewind(legacyContext);
    initLegacyUserBubble(legacyContext);
    initLegacyDeferredNext(legacyContext);
    setupChangeReviewFileReview();
    setupCommandMenuTransientSelectionCleanup();
    setupCustomModelPicker();
    initLegacyAskRefinement(legacyContext);
    initLegacyTranscriptActionDebug(legacyContext);
    reportHealth('legacy', 'ok');
  }

  whenDOMReady(init);
})();
