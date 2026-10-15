import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type UIEvent } from "react";
import { getProfileInfo, getTemplateForProfile, type ProfileInfo } from "./templates";
import { tokenizeCode } from "./codeTokenizer";
import styles from "./botEditor.module.css";

export const MAX_SOURCE_BYTES = 262_144; // 256 KiB default limit for bot sources

export interface BotSourceEditorProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly profileId: string;
  readonly onRunDraft?: () => void;
  readonly disabled?: boolean;
  readonly maxBytes?: number;
  readonly className?: string;
  readonly id?: string;
}

function computeUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return new Blob([text]).size;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function BotSourceEditor({
  value,
  onChange,
  profileId,
  onRunDraft,
  disabled = false,
  maxBytes = MAX_SOURCE_BYTES,
  className,
  id: customId,
}: BotSourceEditorProps) {
  const generatedId = useId();
  const textareaId = customId || `source-editor-${generatedId}`;
  const hintId = `source-hint-${generatedId}`;
  const statusId = `source-status-${generatedId}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeReaderRef = useRef<FileReader | null>(null);
  const activeReadIdRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  const [fileError, setFileError] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(true);

  // Invalidate any ongoing file reading on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      activeReadIdRef.current++;
      if (activeReaderRef.current) {
        activeReaderRef.current.abort();
        activeReaderRef.current = null;
      }
    };
  }, []);

  // Invalidate any ongoing file reading if profileId changes
  useEffect(() => {
    activeReadIdRef.current++;
    if (activeReaderRef.current) {
      activeReaderRef.current.abort();
      activeReaderRef.current = null;
    }
  }, [profileId]);

  const overlayRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const profileInfo: ProfileInfo = useMemo(() => getProfileInfo(profileId), [profileId]);

  const byteLength = useMemo(() => computeUtf8ByteLength(value), [value]);
  const lineCount = useMemo(() => (value ? value.split("\n").length : 1), [value]);

  const isOverLimit = byteLength > maxBytes;
  const isNearLimit = byteLength > maxBytes * 0.9 && !isOverLimit;

  const tokens = useMemo(() => tokenizeCode(value, profileId), [value, profileId]);

  const lineNumbers = useMemo(() => {
    const count = Math.max(1, lineCount);
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [lineCount]);

  const handleScroll = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    if (overlayRef.current) {
      overlayRef.current.scrollTop = target.scrollTop;
      overlayRef.current.scrollLeft = target.scrollLeft;
    }
    if (lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = target.scrollTop;
    }
  }, []);

  // Handle Tab key (indent) and Ctrl/Cmd+Enter (run draft)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (onRunDraft) {
          onRunDraft();
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const spaces = "  ";
        const nextValue = value.substring(0, start) + spaces + value.substring(end);
        onChange(nextValue);
        // Retain cursor position after insertion
        requestAnimationFrame(() => {
          textarea.selectionStart = start + spaces.length;
          textarea.selectionEnd = start + spaces.length;
        });
      }
    },
    [value, onChange, onRunDraft]
  );

  // Load starter template with draft confirmation
  const handleLoadTemplate = useCallback(() => {
    if (disabled) return;
    if (value.trim().length > 0) {
      const ok =
        typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm(
              "Bản nháp hiện tại chưa được lưu. Bạn có chắc chắn muốn thay thế bằng mã mẫu starter không?"
            )
          : true;
      if (!ok) return;
    }
    // Invalidate any pending file read
    activeReadIdRef.current++;
    if (activeReaderRef.current) {
      activeReaderRef.current.abort();
      activeReaderRef.current = null;
    }
    const template = getTemplateForProfile(profileId);
    onChange(template);
    setFileError(null);
  }, [disabled, value, profileId, onChange]);

  // Trigger hidden file input
  const handleTriggerFileInput = useCallback(() => {
    if (disabled || !fileInputRef.current) return;
    fileInputRef.current.click();
  }, [disabled]);

  // Process chosen file
  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Validate size
      if (file.size > maxBytes) {
        setFileError(
          `Tệp "${file.name}" (${formatByteSize(file.size)}) vượt quá kích thước tối đa cho phép (${formatByteSize(maxBytes)}).`
        );
        e.target.value = "";
        return;
      }

      // Check draft confirmation
      if (value.trim().length > 0) {
        const ok =
          typeof window !== "undefined" && typeof window.confirm === "function"
            ? window.confirm(
                `Bản nháp hiện tại sẽ bị thay thế bằng nội dung tệp "${file.name}". Tiếp tục?`
              )
            : true;
        if (!ok) {
          e.target.value = "";
          return;
        }
      }

      // Abort any prior reader and advance read ID to guard against stale async callbacks
      if (activeReaderRef.current) {
        activeReaderRef.current.abort();
      }
      const currentReadId = ++activeReadIdRef.current;
      const reader = new FileReader();
      activeReaderRef.current = reader;

      reader.onload = () => {
        // Discard if component unmounted or a newer read / action occurred
        if (!isMountedRef.current || activeReadIdRef.current !== currentReadId) {
          return;
        }
        activeReaderRef.current = null;

        try {
          const buffer = reader.result as ArrayBuffer;
          // Strict UTF-8 decoding: throws TypeError on invalid byte sequences or malformed utf-8
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const content = decoder.decode(buffer);
          onChange(content);
          setFileError(null);
        } catch {
          setFileError(
            `Tệp "${file.name}" không hợp lệ: tệp phải có định dạng văn bản UTF-8 hợp lệ.`
          );
        }
      };

      reader.onerror = () => {
        if (!isMountedRef.current || activeReadIdRef.current !== currentReadId) {
          return;
        }
        activeReaderRef.current = null;
        setFileError(`Không thể đọc tệp "${file.name}": ${reader.error?.message || "Lỗi tệp tin"}`);
      };

      reader.onabort = () => {
        // Aborted reads are silently ignored
      };

      reader.readAsArrayBuffer(file);
      e.target.value = "";
    },
    [maxBytes, value, onChange]
  );

  const acceptExtensions = useMemo(() => {
    return profileInfo.fileExtensions.join(",");
  }, [profileInfo]);

  return (
    <div className={[styles.editorWrapper, className || ""].join(" ")}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.profileBadge} title={`Môi trường: ${profileInfo.displayName}`}>
            {profileInfo.displayName}
          </span>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={handleLoadTemplate}
            disabled={disabled}
            aria-label="Tải mã mẫu starter cho môi trường này"
          >
            Mã mẫu starter
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={handleTriggerFileInput}
            disabled={disabled}
            aria-label="Nhập mã nguồn từ tệp trên máy"
          >
            Nhập từ tệp...
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className={styles.fileInputHidden}
            accept={acceptExtensions}
            onChange={handleFileChange}
            disabled={disabled}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>

        <div className={styles.toolbarRight}>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => setShowHint((prev) => !prev)}
            aria-expanded={showHint}
            aria-controls={hintId}
          >
            {showHint ? "Ẩn hướng dẫn" : "Hiện hướng dẫn"}
          </button>
        </div>
      </div>

      {/* Protocol & Profile hints */}
      {showHint && (
        <div id={hintId} className={styles.hintBox} role="region" aria-label="Hướng dẫn môi trường">
          <div className={styles.hintHeader}>
            <span>{profileInfo.displayName}</span>
            <span>·</span>
            <span>Giao thức Arena Protocol v1 (STDIO NDJSON)</span>
          </div>
          <div className={styles.protocolDetail}>{profileInfo.protocolHint}</div>
          <div className={styles.formatTags}>
            <small>Định dạng tệp:</small>
            {profileInfo.fileExtensions.map((ext) => (
              <span key={ext} className={styles.extTag}>
                {ext}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Error alert banner */}
      {fileError && (
        <div className={styles.errorBanner} role="alert">
          <span>{fileError}</span>
          <button
            type="button"
            className={styles.errorDismissBtn}
            onClick={() => setFileError(null)}
            aria-label="Đóng thông báo lỗi"
          >
            ✕
          </button>
        </div>
      )}

      {/* Over-limit alert */}
      {isOverLimit && (
        <div className={styles.errorBanner} role="alert">
          <span>
            Mã nguồn hiện tại ({formatByteSize(byteLength)}) vượt quá giới hạn tối đa cho phép (
            {formatByteSize(maxBytes)}). Vui lòng rút gọn mã trước khi nộp.
          </span>
        </div>
      )}

      {/* Editor & textarea with syntax highlight overlay */}
      <div className={styles.editorArea}>
        <div
          className={[
            styles.editorContainer,
            disabled ? styles.editorContainerDisabled : "",
            isOverLimit ? styles.editorContainerDanger : "",
          ].join(" ")}
        >
          {/* Line numbers gutter */}
          <div className={styles.lineNumbers} aria-hidden="true" ref={lineNumbersRef}>
            {lineNumbers.map((num) => (
              <div key={num} className={styles.lineNumber}>
                {num}
              </div>
            ))}
          </div>

          <div className={styles.textareaWrapper}>
            {/* Syntax highlighted overlay: aria-hidden="true", never dangerouslySetInnerHTML */}
            <pre ref={overlayRef} className={styles.syntaxOverlay} aria-hidden="true">
              <code>
                {tokens.map((token, idx) =>
                  token.type === "text" ? (
                    token.content
                  ) : (
                    <span key={idx} className={styles[`token_${token.type}`]}>
                      {token.content}
                    </span>
                  )
                )}
              </code>
            </pre>

            <textarea
              id={textareaId}
              className={[
                styles.sourceTextarea,
                disabled ? styles.sourceTextareaDisabled : "",
                isOverLimit ? styles.sourceTextareaDanger : "",
              ].join(" ")}
              value={value}
              onChange={(e) => {
                activeReadIdRef.current++;
                if (activeReaderRef.current) {
                  activeReaderRef.current.abort();
                  activeReaderRef.current = null;
                }
                onChange(e.target.value);
                if (fileError) setFileError(null);
              }}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
              disabled={disabled}
              placeholder="// Nhập hoặc dán mã nguồn bot tại đây..."
              aria-label="Mã nguồn bot"
              aria-describedby={`${statusId} ${showHint ? hintId : ""}`}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
            />
          </div>
        </div>

        {/* Status bar */}
        <div id={statusId} className={styles.statusBar}>
          <div className={styles.statusMeta}>
            <span>Dòng: {lineCount}</span>
            <span>Ký tự: {value.length}</span>
          </div>
          <div
            className={[
              styles.byteCounter,
              isOverLimit
                ? styles.byteCounterDanger
                : isNearLimit
                  ? styles.byteCounterWarning
                  : "",
            ].join(" ")}
            aria-live="polite"
          >
            <span>Dung lượng:</span>
            <strong>{formatByteSize(byteLength)}</strong>
            <span>/</span>
            <span>{formatByteSize(maxBytes)}</span>
            {isOverLimit && <span>(Vượt giới hạn!)</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
