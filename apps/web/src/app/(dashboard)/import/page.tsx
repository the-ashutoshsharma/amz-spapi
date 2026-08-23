'use client';

import { useCallback, useRef, useState } from 'react';
import { FileUp, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * One place to bring outside data in.
 *
 * Two different pipelines sit behind a single drop zone, chosen by what the
 * file IS rather than by asking the user: tabular Amazon exports are parsed
 * into de-duplicated report rows, while PDFs, images and design files are
 * stored as documents. Making the user pick the right uploader would only
 * create a way to get it wrong.
 *
 * The report half also matters because it needs no Amazon permissions — for a
 * report behind a role the app has not been granted, this is the only way in.
 */

type ImportResult = {
  kind: string;
  /** The document route names the kind for us; the report route does not. */
  label?: string;
  rowsParsed: number;
  rowsNew: number;
  rowsDuplicate: number;
  /**
   * Already-held rows re-read under the current column mapping — a subset of
   * `rowsDuplicate`. Non-zero means an earlier import of this file captured
   * less than the registry maps today, which is the only signal that
   * re-importing an old export was worth doing.
   */
  rowsRefreshed?: number;
  unmappedHeaders?: string[];
  observedFrom?: string;
  observedTo?: string;
  detectionConfidence?: number;
  /**
   * What the seller must be told about a load that nonetheless succeeded: an
   * overlap with days the ads sync already holds, or an overlap check that
   * could not run at all.
   *
   * The importer raises these because a check that could not run is not the
   * same as a check that passed — and this page used to drop them on the
   * floor, which is exactly the silence they exist to remove.
   */
  warnings?: string[];
};

type ImportError = {
  error: string;
  candidates?: Array<{ kind: string; matched: number; possible: number }>;
  /**
   * Set when the refusal is an ads-sync overlap. The message tells the seller
   * they may import it anyway if this is a different advertiser profile, so
   * there has to be a way to do that — the route has always accepted
   * `allowOverlap`, and nothing ever sent it.
   */
  overlap?: { kind: string; from: string; to: string; profileId: string };
};

type DocumentResult = {
  assetId: string;
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  duplicate?: boolean;
  /**
   * Set when the file was recognised as an Amazon export and its rows were
   * stored. A `.xlsx` export lands here rather than on the report route, so
   * without this the page that exists to import reports said nothing whatever
   * about the rows it had just imported.
   */
  report?: ImportResult;
  /** The rows did NOT go in. The file is still stored; the numbers are not. */
  reportError?: string;
  /** Read as a document, but the figures could not be extracted from it. */
  extractionError?: string;
  /** Figures were read and then could not be filed for later reconciliation. */
  documentStoreError?: string;
  /** The sheet preview could not be built. The file is stored regardless. */
  spreadsheetError?: string;
  recognition?: {
    kind: string;
    confidence: number;
    needsUserChoice: boolean;
    signals: string[];
    alternatives: string[];
  };
  boxLabelsStored?: number;
  boxLabelSummary?: Array<{
    shipmentId: string;
    destinationFc?: string;
    boxesSeen: number;
    boxesDeclared?: number;
    complete: boolean;
    units: Array<{ sku: string; quantity: number; boxes: number }>;
    totalUnits: number;
    warnings: string[];
  }>;
};

/** What each recognised kind is called in the UI. */
const DOCUMENT_LABELS: Record<string, string> = {
  'commercial-invoice': 'Commercial invoice',
  'purchase-order': 'Purchase order',
  receipt: 'Receipt',
  'proof-of-delivery': 'Proof of delivery',
  'transport-document': 'Transport document',
  'customs-declaration': 'Customs declaration',
  'packing-list': 'Packing list',
  'fba-box-label': 'FBA box label',
  'fnsku-label': 'FNSKU label',
  'design-artwork': 'Design artwork',
  spreadsheet: 'Spreadsheet',
  unknown: 'Unrecognised',
};

type Row = {
  id: string;
  fileName: string;
  kind: 'report' | 'document';
  status: 'uploading' | 'done' | 'failed';
  result?: ImportResult;
  document?: DocumentResult;
  /** Looked like a report by extension but was not one; kept as a document. */
  notReport?: boolean;
  error?: ImportError;
  /**
   * The file itself, kept ONLY for a refusal the seller is allowed to
   * override. Holding every upload would be expensive for the case this page
   * is built for — a year of settlements is around 5 MB each — so it is
   * attached to the one row that has a use for it.
   */
  retry?: File;
  /** True while that override is in flight. */
  retrying?: boolean;
};

/**
 * How many uploads are in flight at once.
 *
 * Sequential was fine for one file and slow for a backfill: a year of
 * settlements is roughly twenty-six of them, each its own request. Unbounded
 * `Promise.all` is the wrong other extreme — it opens every connection at once
 * and hands the API route a thundering herd, for no gain once the link is
 * saturated.
 *
 * Files stay one-per-request whatever this is set to. Batching several into one
 * body would be worse: a year is around 5 MB and the platform rejects a request
 * body over 4.5 MB, so the batch would work in testing and fail on the real
 * backfill. Per-file also means per-file reconciliation feedback, and an import
 * that dedupes on re-upload, so a partial failure is repaired by dropping the
 * same folder in again.
 */
const UPLOAD_CONCURRENCY = 5;

/**
 * Run `worker` over `items`, at most `limit` at a time, in order.
 *
 * Workers share one cursor rather than taking a fixed slice each, so a slow
 * file holds up only itself: whichever worker frees first takes the next file.
 * Never rejects — `worker` is expected to record its own failures, and one bad
 * file must not abandon the rest of the batch.
 */
async function runPooled<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const take = async (): Promise<void> => {
    // Safe without a lock: nothing awaits between reading and advancing.
    while (cursor < items.length) await worker(items[cursor++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, take)
  );
}

/** Tabular exports go to the report parser; everything else is a document. */
const REPORT_EXTENSIONS = new Set(['txt', 'tsv', 'csv']);

function classify(file: File): 'report' | 'document' {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (REPORT_EXTENSIONS.has(extension)) return 'report';
  // A .xlsx is tabular but not what Amazon exports, so it goes to the document
  // importer — which converts a workbook and files it as a report anyway when
  // the headers say it is one. Feeding the raw zip to the report parser here
  // would only fail.
  return 'document';
}

/**
 * One file, one request.
 *
 * `allowOverlap` is the seller's answer to a refusal, not a default: the ads
 * sync and a console export spell their columns differently, so days held by
 * both are stored twice rather than merged. The route has always accepted it.
 */
async function send(
  endpoint: string,
  file: File,
  allowOverlap = false
): Promise<{ response: Response; payload: unknown }> {
  const body = new FormData();
  body.append('file', file);
  if (allowOverlap) body.append('allowOverlap', 'true');
  const response = await fetch(endpoint, { method: 'POST', body });
  // A crashed route answers with an HTML error page, and json() then throws
  // "Unexpected end of JSON input" — which tells the user nothing. Fall back
  // to the status.
  const payload = await response.json().catch(() => ({
    error: `Server error (HTTP ${response.status}). Check the server log.`,
  }));
  return { response, payload };
}

/**
 * Labels for the kinds detection can return. Kept in step with the registry in
 * `sp-cache` by hand: importing it here would pull the Couchbase client into a
 * client component.
 */
const REPORT_LABELS: Record<string, string> = {
  'ledger-detail': 'Inventory Ledger — Detail',
  'ledger-summary': 'Inventory Ledger — Summary',
  stranded: 'Stranded Inventory',
  'removal-order': 'Removal Order Detail',
  'removal-shipment': 'Removal Shipment Detail',
  reimbursement: 'Reimbursements',
  'inbound-performance': 'FBA Inbound Performance',
  settlement: 'Settlement (payments archive)',
  'storage-fee': 'FBA Monthly Storage Fees',
  'search-term': 'Sponsored Products search terms',
  'campaign-performance': 'Sponsored Products campaign performance',
};

export default function ReportsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** See the drop zone's `onDragEnter` — counts descendants, not booleans. */
  const dragDepthRef = useRef(0);

  const upload = useCallback(async (files: FileList | File[]) => {
    const uploadOne = async (file: File) => {
      const id = `${file.name}-${Date.now()}-${Math.random()}`;
      const kind = classify(file);
      setRows((current) => [
        { id, fileName: file.name, kind, status: 'uploading' },
        ...current,
      ]);

      try {
        let asKind = kind;
        let { response, payload } = await send(
          kind === 'report' ? '/api/reports/import' : '/api/documents/import',
          file
        );

        // A .csv or .txt that is not an Amazon export — a supplier price list,
        // say — should not be a dead end. Keep the file as a document rather
        // than telling the user their upload failed.
        if (!response.ok && kind === 'report' && response.status === 422) {
          const retry = await send('/api/documents/import', file);
          if (retry.response.ok) {
            asKind = 'document';
            response = retry.response;
            payload = retry.payload;
          }
        }

        setRows((current) =>
          current.map((row) =>
            row.id === id
              ? response.ok
                ? {
                    ...row,
                    kind: asKind,
                    status: 'done',
                    ...(asKind === 'report'
                      ? { result: payload as ImportResult }
                      : {
                          document: payload as DocumentResult,
                          notReport: kind === 'report',
                        }),
                  }
                : {
                    ...row,
                    status: 'failed',
                    error: payload as ImportError,
                    // Only an overridable refusal keeps the bytes around.
                    ...((payload as ImportError).overlap
                      ? { retry: file }
                      : {}),
                  }
              : row
          )
        );
      } catch (error) {
        setRows((current) =>
          current.map((row) =>
            row.id === id
              ? {
                  ...row,
                  status: 'failed',
                  error: {
                    error:
                      error instanceof Error ? error.message : 'Upload failed.',
                  },
                }
              : row
          )
        );
      }
    };

    await runPooled(Array.from(files), UPLOAD_CONCURRENCY, uploadOne);
  }, []);

  /**
   * Load a file the overlap guard refused.
   *
   * The refusal ends with "or import it anyway if this is a different
   * advertiser profile", which was advice about a button that did not exist:
   * the only way through was to narrow the export's date range in Seller
   * Central and download it again.
   */
  const importAnyway = useCallback(async (id: string, file: File) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, retrying: true } : row))
    );

    const { response, payload } = await send(
      '/api/reports/import',
      file,
      true
    ).catch(() => ({ response: undefined, payload: undefined }));

    setRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;
        if (response?.ok) {
          return {
            ...row,
            status: 'done',
            result: payload as ImportResult,
            error: undefined,
            retry: undefined,
            retrying: false,
          };
        }
        return {
          ...row,
          retrying: false,
          error: (payload as ImportError) ?? {
            error: 'Import failed. Check the server log.',
          },
        };
      })
    );
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Import</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Drop Amazon report exports, supplier invoices, receipts, proofs of
        delivery or packaging artwork. Each file is routed by what it is —
        reports are parsed into rows and de-duplicated, so re-importing an
        overlapping date range is safe; documents are stored against this
        account.
      </p>

      {/*
        A button, not a div with an onClick. The file input below is
        `display:none`, so it is not focusable either — between them a keyboard
        user had no way at all to reach the only control on the page.
      */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Choose report or document files to import"
        onDragEnter={(event) => {
          event.preventDefault();
          // Nested children each fire their own dragenter/leave, so a boolean
          // flip flickers the highlight as the pointer crosses the text inside
          // the zone. Depth tracks how many descendants currently contain the
          // drag; the highlight drops only when it leaves the zone entirely.
          dragDepthRef.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragging(false);
          if (event.dataTransfer.files?.length)
            upload(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          // Space scrolls the page otherwise, which is the opposite of opening
          // the picker the key was pressed for.
          event.preventDefault();
          inputRef.current?.click();
        }}
        className={cn(
          'mt-6 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 text-center transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50'
        )}
      >
        <FileUp className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          Drop report files, or click to choose
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Reports (.txt, .tsv, .csv, .xlsx) — ledger, stranded, removals,
          reimbursements, inbound performance, settlements, storage fees, ads
          search terms &amp; campaigns
          <br />
          Documents (.pdf, .docx, .ai, images) — invoices, receipts, POs, PODs,
          box designs
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          // Kept in step with what the ROUTE accepts, extension and MIME both:
          // some macOS/browser pairs enable Office files by their registered
          // MIME type rather than the extension, and a picker stricter than
          // the endpoint reads as "this file type is unsupported" when it is
          // merely unlisted. (Drag-and-drop ignores this list entirely, which
          // is how the mismatch stayed invisible.)
          accept={[
            '.txt',
            '.tsv',
            '.csv',
            '.pdf',
            '.docx',
            '.xlsx',
            '.xls',
            '.ai',
            '.png',
            '.jpg',
            '.jpeg',
            '.heic',
            'text/plain',
            'text/tab-separated-values',
            'text/csv',
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'image/*',
          ].join(',')}
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      <div className="mt-6 space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="rounded-lg border p-4">
            <div className="flex items-center gap-2">
              {row.status === 'uploading' ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : row.status === 'done' ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              )}
              <span className="truncate text-sm font-medium">
                {row.fileName}
              </span>
              {/* An .xlsx that WAS imported as a ledger is not "Document" —
                  the badge is the only thing on the card that names what the
                  file turned out to be. */}
              <span className="ml-auto text-xs text-muted-foreground">
                {reportLabel(row.result ?? row.document?.report) ??
                  (row.document || row.kind === 'document'
                    ? 'Document'
                    : 'Report')}
              </span>
            </div>

            {row.document ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <Stat
                  label="Stored"
                  value={`${(row.document.sizeBytes / 1024).toFixed(0)} KB`}
                />
                <Stat label="Type" value={row.document.mimeType} muted />
                <Stat
                  label="Asset"
                  value={row.document.assetId.slice(0, 14) + '…'}
                  muted
                />
                <Stat
                  label="Preview"
                  value={
                    row.document.mimeType.startsWith('image/')
                      ? 'available'
                      : 'download only'
                  }
                  muted
                />
              </dl>
            ) : null}

            {row.result ? <ReportOutcome result={row.result} /> : null}

            {/* A .xlsx export is routed to the DOCUMENT importer, which files
                its rows all the same. Without this the page whose job is
                importing reports said nothing about the rows it had just
                imported — the seller saw a stored file and no numbers. */}
            {row.document?.report ? (
              <ReportOutcome result={row.document.report} />
            ) : null}

            {row.notReport && !row.document?.report ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Not a recognised Amazon report kind — stored whole. Chat can
                answer questions over every row of it (attach it there, or ask
                about it by name). If this is a report the app should recognise,
                say which and it can be added.
              </p>
            ) : null}

            {/* De-duplication is the same promise on both halves of this page,
                and only the report half was keeping it: a re-uploaded PDF
                reported a fresh store, so a folder dropped twice looked like
                twice the documents. */}
            {row.document?.duplicate ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Already held — the identical file is stored once, so this
                changed nothing.
              </p>
            ) : null}

            {/* What did not happen. Each of these is a step the route lets
                fail on purpose so the upload survives it, and each was
                arriving as silence: a green tick over a document whose figures
                were never read. */}
            {row.document ? <DocumentIssues stored={row.document} /> : null}

            {/* The shipped side: what this sheet says the seller sent. A
                label PDF holds one label per box, so a shipment is summarised
                rather than a single box reported. */}
            {row.document?.boxLabelSummary?.map((shipment) => (
              <div key={shipment.shipmentId} className="mt-3">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Shipment" value={shipment.shipmentId} />
                  <Stat
                    label="Boxes"
                    value={`${shipment.boxesSeen} of ${
                      shipment.boxesDeclared ?? '?'
                    }`}
                  />
                  <Stat label="Units" value={`${shipment.totalUnits}`} />
                  <Stat
                    label="Destination"
                    value={shipment.destinationFc ?? '—'}
                    muted
                  />
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                  {shipment.units
                    .map((unit) => `${unit.sku} ${unit.quantity}`)
                    .join(' · ')}
                  {shipment.complete ? ' — complete' : ''}
                </p>
                {shipment.warnings.length ? (
                  <p className="mt-1 text-xs text-amber-700">
                    {shipment.warnings.join('; ')}
                  </p>
                ) : null}
              </div>
            ))}

            {/* Show the reasons, not just the verdict: a classification the
                seller can argue with is one they can correct. */}
            {row.document?.recognition ? (
              <div className="mt-3 text-xs">
                <p
                  className={
                    row.document.recognition.needsUserChoice
                      ? 'text-amber-700'
                      : 'text-muted-foreground'
                  }
                >
                  {DOCUMENT_LABELS[row.document.recognition.kind] ??
                    row.document.recognition.kind}
                  {row.document.recognition.confidence > 0
                    ? ` — confidence ${row.document.recognition.confidence.toFixed(
                        2
                      )}`
                    : ''}
                  {row.document.recognition.needsUserChoice
                    ? ' — needs confirmation'
                    : ''}
                </p>
                {row.document.recognition.signals.length ? (
                  <p className="mt-1 text-muted-foreground">
                    {row.document.recognition.signals.slice(0, 4).join('; ')}
                  </p>
                ) : null}
                {row.document.recognition.alternatives.length ? (
                  <p className="mt-1 text-muted-foreground">
                    Could also be:{' '}
                    {row.document.recognition.alternatives
                      .map((kind) => DOCUMENT_LABELS[kind] ?? kind)
                      .join(', ')}
                  </p>
                ) : null}
              </div>
            ) : null}

            {row.error ? (
              <div className="mt-2 text-sm text-amber-800">
                <p>{row.error.error}</p>
                {row.retry ? (
                  <button
                    type="button"
                    disabled={row.retrying}
                    onClick={() => {
                      // Read here rather than narrowed through the closure:
                      // `retry` is optional and TypeScript will not carry the
                      // narrowing into a callback.
                      const file = row.retry;
                      if (file) void importAnyway(row.id, file);
                    }}
                    className="mt-2 rounded-md border border-amber-700/40 px-2.5 py-1 text-xs font-medium hover:bg-amber-700/10 disabled:opacity-60"
                  >
                    {row.retrying ? 'Importing…' : 'Import anyway'}
                  </button>
                ) : null}
                {row.error.candidates?.length ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Closest matches:{' '}
                    {row.error.candidates
                      .filter((candidate) => candidate.matched > 0)
                      .sort((a, b) => b.matched - a.matched)
                      .slice(0, 3)
                      .map(
                        (candidate) =>
                          `${
                            REPORT_LABELS[candidate.kind] ?? candidate.kind
                          } (${candidate.matched}/${
                            candidate.possible
                          } columns)`
                      )
                      .join(', ') || 'none'}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The kind a report import settled on, named for the badge. */
function reportLabel(result?: ImportResult): string | undefined {
  if (!result) return undefined;
  return result.label ?? REPORT_LABELS[result.kind] ?? result.kind;
}

/**
 * What an import did, for either route that can do one.
 *
 * Shared because a `.csv` goes to the report route and a `.xlsx` to the
 * document route, and the seller has no reason to care which — the numbers
 * mean the same thing and were only being shown for one of them.
 */
function ReportOutcome({ result }: { result: ImportResult }) {
  const unmapped = result.unmappedHeaders ?? [];
  return (
    <>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="New rows" value={result.rowsNew} />
        <Stat label="Already held" value={result.rowsDuplicate} muted />
        <Stat label="Parsed" value={result.rowsParsed} muted />
        <Stat
          label="Covers"
          value={
            result.observedFrom && result.observedTo
              ? `${result.observedFrom} → ${result.observedTo}`
              : '—'
          }
          muted
        />
      </dl>

      {result.rowsRefreshed ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {result.rowsRefreshed} already-held{' '}
          {result.rowsRefreshed === 1 ? 'row was' : 'rows were'} re-read under
          the current column mapping — an earlier import of this file captured
          less.
        </p>
      ) : null}

      {/* A load that succeeded and still has something to say: days the ads
          sync already holds, or a guard that could not run. */}
      {result.warnings?.length ? (
        <ul className="mt-2 space-y-1 text-xs text-amber-700">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {/* Unrecognised columns are kept verbatim, and saying so is how a
          mapping that has drifted becomes visible instead of silent — but a
          stranded-inventory export has eighty of them, and printing the list
          buried the four numbers above it under a wall of orange. Folded, so
          the count is the headline and the names are one click away. */}
      {unmapped.length ? (
        <details className="mt-2 text-xs text-amber-700">
          <summary className="cursor-pointer">
            {unmapped.length} {unmapped.length === 1 ? 'column' : 'columns'} not
            recognised — stored, but not searchable
          </summary>
          <p className="mt-1 break-words">{unmapped.join(', ')}</p>
        </details>
      ) : null}
    </>
  );
}

/**
 * The steps that failed without failing the upload.
 *
 * Each of these is deliberate on the server — the file is stored and
 * classified whatever else goes wrong — and each was reaching the seller as
 * nothing at all, under a green tick.
 */
function DocumentIssues({ stored }: { stored: DocumentResult }) {
  const issues = [
    stored.reportError && `Rows not imported: ${stored.reportError}`,
    stored.extractionError &&
      `Figures not read from it: ${stored.extractionError}`,
    stored.documentStoreError &&
      `Read, but not filed for reconciliation: ${stored.documentStoreError}`,
    stored.spreadsheetError &&
      `Preview unavailable: ${stored.spreadsheetError}`,
  ].filter((issue): issue is string => Boolean(issue));

  if (!issues.length) return null;

  return (
    <ul className="mt-2 space-y-1 text-xs text-amber-700">
      {issues.map((issue) => (
        <li key={issue}>{issue}</li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  value,
  muted,
}: {
  label: string;
  value: string | number;
  muted?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('font-medium', muted && 'text-muted-foreground')}>
        {value}
      </dd>
    </div>
  );
}
