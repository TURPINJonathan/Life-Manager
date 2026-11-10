import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useParams, useSearchParams } from 'react-router';

import {
  Button,
  CategoryChip,
  ChoiceCards,
  ConfirmDialog,
  DateField,
  Dialog,
  EmptyState,
  FormField,
  Icon,
  IconButton,
  Select,
  Tooltip,
  TpeAmountInput,
  Typography,
} from '@components';
import {
  APP_CHROME_ROW_CLASSES,
  APP_PAGE_FILL_CLASSES,
  APP_PINNED_DETAIL_BODY_CLASSES,
  APP_PINNED_DETAIL_CHROME_CLASSES,
  APP_ROUTE,
  BUTTON_VARIANT,
  DIALOG_SIZE,
  FIELD_CONTROL_CLASSES,
  ICON_BUTTON_VARIANT,
  PAYMENT_METHOD_ICONS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  appTitle,
  currentYearMonth,
} from '@constants';
import { useDocumentTitle } from '@hooks';
import { CategoryQuickCreate } from '@categories';
import { MerchantQuickCreate, MerchantVisual } from '@merchants';
import {
  ApiError,
  apiFetch,
  createTransaction,
  deleteTransaction,
  deleteTransactionAttachment,
  fetchLedger,
  listAccounts,
  listCategories,
  listMerchants,
  updateTransaction,
  uploadTransactionAttachment,
  type TransactionInput,
} from '@services';
import { useAuthStore } from '@store';
import type { Account, Category, LedgerPayload, LedgerTransaction, Merchant, PaymentMethod } from '@app-types';
import {
  centsToInput,
  cn,
  formatCents,
  formatIsoDateFr,
  parseEurosToCents,
  signedAmountClass,
  todayIsoLocal,
  toastError,
  toastFromError,
  toastInfo,
  toastSuccess,
} from '@utils';

import { buildCategorySelectOptions } from './category-select-options';
import { ForecastPanel, type ForecastChromeActions } from './forecast-panel.component';
import { buildMerchantSelectOptions, favoriteMerchantIdForCategory } from './merchant-select-options';
import { SubAccountSwitcher } from './sub-account-switcher.component';

const ATTACHMENT_ACCEPT = 'image/*,application/pdf,.pdf,.jpg,.jpeg,.png,.webp';
const LEDGER_PAGE_SIZE = 50;

type TxForm = {
  categoryId: string;
  merchantId: string;
  operationDate: string;
  effectiveDate: string;
  paymentMethod: PaymentMethod;
  checkNumber: string;
  designation: string;
  amount: string;
  flow: 'credit' | 'debit';
};

type LedgerView = 'operations' | 'budget';

function isYearMonth(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}$/.test(value));
}

export function AccountLedgerPage() {
  const { subAccountId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const view: LedgerView = searchParams.get('vue') === 'budget' ? 'budget' : 'operations';
  const budgetMonth = isYearMonth(searchParams.get('mois')) ? searchParams.get('mois')! : currentYearMonth();
  const token = useAuthStore((state) => state.token);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [ledger, setLedger] = useState<LedgerPayload | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editing, setEditing] = useState<LedgerTransaction | null>(null);
  const [creating, setCreating] = useState(false);
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false);
  const [merchantCreateOpen, setMerchantCreateOpen] = useState(false);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [removeAttachment, setRemoveAttachment] = useState(false);
  const [attachmentDragging, setAttachmentDragging] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const [pendingDelete, setPendingDelete] = useState<LedgerTransaction | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [budgetActions, setBudgetActions] = useState<ForecastChromeActions | null>(null);

  useDocumentTitle(appTitle(ledger?.subAccount.name ?? 'Compte', view === 'budget' ? 'Budget' : 'Opérations'));

  const form = useForm<TxForm>({
    defaultValues: {
      categoryId: '',
      merchantId: '',
      operationDate: todayIsoLocal(),
      effectiveDate: '',
      paymentMethod: 'card',
      checkNumber: '',
      designation: '',
      amount: '',
      flow: 'debit',
    },
  });

  const paymentMethod = form.watch('paymentMethod');
  const categoryId = form.watch('categoryId');
  const merchantId = form.watch('merchantId');
  const flow = form.watch('flow');
  const selectedCategory = categories.find((category) => category.id === categoryId) ?? null;
  const amountIsExpense =
    selectedCategory?.kind === 'expense' ||
    (selectedCategory?.kind === 'both' && flow === 'debit') ||
    (!selectedCategory && flow === 'debit');
  const amountToneClass = amountIsExpense ? 'text-error' : 'text-success-strong';

  const setView = (next: LedgerView) => {
    if (next === 'budget') {
      setSearchParams({ vue: 'budget', mois: budgetMonth });
      return;
    }
    setBudgetActions(null);
    setSearchParams({});
  };

  const setBudgetMonth = (next: string) => {
    setSearchParams({ vue: 'budget', mois: next });
  };
  const focusLineId = searchParams.get('ligne');
  const consumeFocusLine = () => {
    if (!searchParams.get('ligne')) return;
    const params = new URLSearchParams(searchParams);
    params.delete('ligne');
    setSearchParams(params, { replace: true });
  };

  const reload = async () => {
    if (!token || !subAccountId) return;
    setLoading(true);
    try {
      const [ledgerPayload, cats, merchantRows, accountRows] = await Promise.all([
        fetchLedger(token, subAccountId, { limit: LEDGER_PAGE_SIZE, offset: 0 }),
        listCategories(token),
        listMerchants(token),
        listAccounts(token),
      ]);
      setLedger(ledgerPayload);
      setCategories(cats);
      setMerchants(merchantRows);
      setAccounts(accountRows);
    } catch (err) {
      toastFromError(err, 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!token || !subAccountId || !ledger?.hasMore || ledger.nextOffset === null) return;
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchLedger(token, subAccountId, {
        limit: LEDGER_PAGE_SIZE,
        offset: ledger.nextOffset,
      });
      setLedger((prev) => {
        if (!prev) return page;
        return {
          ...page,
          subAccount: page.subAccount,
          openingBalanceCents: page.openingBalanceCents,
          transactions: [...prev.transactions, ...page.transactions],
        };
      });
    } catch (err) {
      toastFromError(err, 'Chargement impossible.');
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, subAccountId]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel || view !== 'operations' || !ledger?.hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { root: sentinel.closest('[data-app-scroll]'), rootMargin: '120px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, ledger?.hasMore, ledger?.nextOffset, ledger?.transactions.length]);

  const openCreate = () => {
    form.reset({
      categoryId: '',
      merchantId: '',
      operationDate: todayIsoLocal(),
      effectiveDate: '',
      paymentMethod: 'card',
      checkNumber: '',
      designation: '',
      amount: '',
      flow: 'debit',
    });
    setAttachmentFile(null);
    setRemoveAttachment(false);
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (tx: LedgerTransaction) => {
    form.reset({
      categoryId: tx.category.id,
      merchantId: tx.merchant?.id ?? '',
      operationDate: tx.operationDate,
      effectiveDate: tx.effectiveDate ?? '',
      paymentMethod: tx.paymentMethod,
      checkNumber: tx.checkNumber ?? '',
      designation: tx.designation,
      amount: centsToInput(Math.abs(tx.amountCents)),
      flow: tx.amountCents >= 0 ? 'credit' : 'debit',
    });
    setAttachmentFile(null);
    setRemoveAttachment(false);
    setCreating(false);
    setEditing(tx);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
    setAttachmentFile(null);
    setRemoveAttachment(false);
  };

  const pickAttachment = (file: File | null) => {
    setAttachmentFile(file);
    if (file) setRemoveAttachment(false);
  };

  const onAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    pickAttachment(event.target.files?.[0] ?? null);
    event.target.value = '';
  };

  const onAttachmentDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentDragging(true);
  };

  const onAttachmentDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentDragging(false);
  };

  const onAttachmentDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    if (!file) return;
    const ok =
      file.type.startsWith('image/') || file.type === 'application/pdf' || /\.(pdf|jpe?g|png|webp)$/i.test(file.name);
    if (!ok) {
      toastError('Fichier non supporté (image ou PDF).');
      return;
    }
    pickAttachment(file);
  };

  const onAttachmentDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    attachmentInputRef.current?.click();
  };

  const openAttachment = async (tx: LedgerTransaction) => {
    if (!token || !tx.attachmentUrl) return;
    try {
      const response = await apiFetch(tx.attachmentUrl, { method: 'GET' }, token);
      if (!response.ok) {
        throw new ApiError('Téléchargement impossible.', response.status);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = tx.attachmentOriginalName ?? 'piece-jointe';
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toastFromError(err, 'Téléchargement impossible.');
    }
  };

  const saveTransaction = async (values: TxForm, mode: 'close' | 'new') => {
    if (!token || !subAccountId) return;
    const isCreate = !editing;
    const amountCents = parseEurosToCents(values.amount);
    if (amountCents === null || amountCents <= 0) {
      toastError('Indique un montant strictement positif ; le sens vient de la catégorie.');
      return;
    }
    const category = categories.find((item) => item.id === values.categoryId);
    if (!category) {
      toastError('Choisis une catégorie.');
      return;
    }
    const body: TransactionInput = {
      categoryId: values.categoryId,
      merchantId: values.merchantId || null,
      operationDate: values.operationDate,
      effectiveDate: values.effectiveDate.trim() === '' ? null : values.effectiveDate,
      paymentMethod: values.paymentMethod,
      checkNumber: values.paymentMethod === 'check' ? values.checkNumber : null,
      designation: values.designation,
      amountCents,
      flow: category.kind === 'both' ? values.flow : null,
    };
    try {
      let saved = editing
        ? await updateTransaction(token, editing.id, body)
        : await createTransaction(token, subAccountId, body);

      if (attachmentFile) {
        saved = await uploadTransactionAttachment(token, saved.id, attachmentFile);
      } else if (editing && removeAttachment && editing.hasAttachment) {
        saved = await deleteTransactionAttachment(token, saved.id);
      }

      toastSuccess(editing ? 'Opération mise à jour.' : 'Opération créée.');

      if (saved.forecastCategoryAdded && saved.forecastCategoryName && saved.forecastYearMonth) {
        const [year, month] = saved.forecastYearMonth.split('-').map(Number);
        const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('fr-FR', {
          month: 'long',
          year: 'numeric',
        });
        toastInfo(`« ${saved.forecastCategoryName} » a été ajouté au budget de ${monthLabel} (planifié 0 €).`);
      }

      if (mode === 'new' && isCreate) {
        form.reset({
          categoryId: '',
          merchantId: '',
          operationDate: todayIsoLocal(),
          effectiveDate: '',
          paymentMethod: 'card',
          checkNumber: '',
          designation: '',
          amount: '',
          flow: 'debit',
        });
        setAttachmentFile(null);
        setRemoveAttachment(false);
        setEditing(null);
        setCreating(true);
      } else {
        closeForm();
      }
      await reload();
    } catch (err) {
      toastFromError(err, 'Enregistrement impossible.');
    }
  };

  const onSubmit = form.handleSubmit((values) => saveTransaction(values, 'close'));
  const onSubmitAndNew = form.handleSubmit((values) => saveTransaction(values, 'new'));

  const resetTransactionForm = () => {
    if (editing) {
      form.reset({
        categoryId: editing.category.id,
        merchantId: editing.merchant?.id ?? '',
        operationDate: editing.operationDate,
        effectiveDate: editing.effectiveDate ?? '',
        paymentMethod: editing.paymentMethod,
        checkNumber: editing.checkNumber ?? '',
        designation: editing.designation,
        amount: centsToInput(Math.abs(editing.amountCents)),
        flow: editing.amountCents >= 0 ? 'credit' : 'debit',
      });
      setAttachmentFile(null);
      setRemoveAttachment(false);
      return;
    }
    form.reset({
      categoryId: '',
      merchantId: '',
      operationDate: todayIsoLocal(),
      effectiveDate: '',
      paymentMethod: 'card',
      checkNumber: '',
      designation: '',
      amount: '',
      flow: 'debit',
    });
    setAttachmentFile(null);
    setRemoveAttachment(false);
  };

  const onDelete = async () => {
    if (!token || !pendingDelete) return;
    setDeleteBusy(true);
    try {
      await deleteTransaction(token, pendingDelete.id);
      toastSuccess('Opération supprimée.');
      setPendingDelete(null);
      await reload();
    } catch (err) {
      toastFromError(err, 'Suppression impossible.');
    } finally {
      setDeleteBusy(false);
    }
  };

  const dialogOpen = creating || editing !== null;
  const transactions = ledger?.transactions ?? [];
  const showExistingAttachment = Boolean(editing?.hasAttachment && !removeAttachment && !attachmentFile);
  const operationsTableActive = view === 'operations' && !loading && Boolean(ledger) && transactions.length > 0;

  return (
    <div className={APP_PAGE_FILL_CLASSES}>
      <div className={APP_PINNED_DETAIL_CHROME_CLASSES}>
        <div className={APP_CHROME_ROW_CLASSES}>
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to={APP_ROUTE.accounts}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-fg-secondary hover:bg-subtle hover:text-fg-primary"
              aria-label="Retour aux comptes"
            >
              <Icon name="arrow_back" className="text-icon-sm" />
            </Link>
            {loading || !ledger ? (
              <p className="text-body text-fg-muted">Chargement…</p>
            ) : (
              <>
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-control text-white sm:size-10"
                  style={{ backgroundColor: ledger.subAccount.color }}
                >
                  <Icon name={ledger.subAccount.icon} className="text-icon-sm" />
                </span>
                <div className="min-w-0 flex-1">
                  <Typography variant="title" as="h1" className="truncate text-fg-primary">
                    {ledger.subAccount.name}
                  </Typography>
                  <p className="flex flex-wrap gap-x-1.5 text-control text-fg-secondary">
                    <span>
                      Solde{' '}
                      <strong className={signedAmountClass(ledger.subAccount.balanceCents)}>
                        {formatCents(ledger.subAccount.balanceCents)}
                      </strong>
                    </span>
                    {ledger.subAccount.provisionalBalanceCents !== ledger.subAccount.balanceCents ? (
                      <span>
                        <span className="text-fg-muted">Provisoire </span>
                        <strong className={signedAmountClass(ledger.subAccount.provisionalBalanceCents)}>
                          {formatCents(ledger.subAccount.provisionalBalanceCents)}
                        </strong>
                      </span>
                    ) : null}
                  </p>
                </div>
              </>
            )}
          </div>

          <div className="flex w-full justify-center md:w-auto md:px-1">
            {view === 'budget' && budgetActions ? (
              <div className="flex items-center gap-0.5">
                <IconButton
                  variant={ICON_BUTTON_VARIANT.ghost}
                  icon="chevron_left"
                  aria-label="Mois précédent"
                  onClick={budgetActions.onPrevMonth}
                />
                <Typography
                  variant="body"
                  weight="semibold"
                  className="min-w-0 max-w-[9.5rem] truncate px-1 text-center tabular-nums sm:min-w-[8.5rem] sm:max-w-none"
                >
                  {budgetActions.monthLabel}
                </Typography>
                <IconButton
                  variant={ICON_BUTTON_VARIANT.ghost}
                  icon="chevron_right"
                  aria-label="Mois suivant"
                  onClick={budgetActions.onNextMonth}
                />
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {!loading && ledger ? (
              <>
                <div
                  className="inline-flex rounded-control border border-border-subtle bg-subtle p-0.5"
                  role="group"
                  aria-label="Vue du compte"
                >
                  <button
                    type="button"
                    onClick={() => setView('operations')}
                    className={cn(
                      'inline-flex h-9 cursor-pointer items-center gap-1 rounded-control px-2 text-control font-medium transition-colors',
                      view === 'operations' ? 'bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
                    )}
                  >
                    <Icon name="receipt_long" className="text-icon-sm" />
                    <span className="hidden sm:inline">Opérations</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('budget')}
                    className={cn(
                      'inline-flex h-9 cursor-pointer items-center gap-1 rounded-control px-2 text-control font-medium transition-colors',
                      view === 'budget' ? 'bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
                    )}
                  >
                    <Icon name="calendar_month" className="text-icon-sm" />
                    <span className="hidden sm:inline">Budget</span>
                  </button>
                </div>

                {view === 'budget' && budgetActions ? (
                  <>
                    {budgetActions.canProject ? (
                      <Tooltip
                        content={
                          budgetActions.projectionActive
                            ? 'Projection active — cliquer pour ajuster'
                            : 'Projection locale (solde ou jour)'
                        }
                      >
                        <IconButton
                          ref={budgetActions.projectionAnchorRef}
                          variant={ICON_BUTTON_VARIANT.ghost}
                          icon="query_stats"
                          aria-label="Projection locale"
                          aria-pressed={budgetActions.projectionActive || budgetActions.projectionOpen}
                          disabled={budgetActions.busy}
                          className={
                            budgetActions.projectionActive || budgetActions.projectionOpen ? 'text-accent' : undefined
                          }
                          onClick={budgetActions.onToggleProjection}
                        />
                      </Tooltip>
                    ) : null}
                    {budgetActions.canDelete ? (
                      <Button
                        type="button"
                        variant={BUTTON_VARIANT.danger}
                        fullWidth={false}
                        className="h-9 w-auto shrink-0 px-2.5 text-control"
                        disabled={budgetActions.busy}
                        onClick={budgetActions.onDelete}
                      >
                        <span className="hidden sm:inline">Supprimer</span>
                        <Icon name="delete" className="text-icon-sm sm:hidden" />
                      </Button>
                    ) : null}
                  </>
                ) : null}

                {view === 'operations' ? (
                  <Button
                    type="button"
                    fullWidth={false}
                    className="h-9 w-auto shrink-0 px-2.5 text-control"
                    onClick={openCreate}
                  >
                    <Icon name="add" className="text-icon-sm" />
                    <span className="hidden sm:inline">Opération</span>
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {accounts.length > 0 && (
          <SubAccountSwitcher
            accounts={accounts}
            activeId={subAccountId}
            view={view}
            yearMonth={view === 'budget' ? budgetMonth : undefined}
          />
        )}
      </div>

      <div
        className={cn(APP_PINNED_DETAIL_BODY_CLASSES, operationsTableActive && 'flex flex-col overflow-hidden')}
        {...(!operationsTableActive ? { 'data-app-scroll': true } : {})}
      >
        {loading || !ledger ? null : view === 'budget' ? (
          <ForecastPanel
            subAccountId={subAccountId}
            categories={categories}
            balanceCents={ledger.subAccount.balanceCents}
            provisionalBalanceCents={ledger.subAccount.provisionalBalanceCents}
            yearMonth={budgetMonth}
            onYearMonthChange={setBudgetMonth}
            focusLineId={focusLineId}
            onFocusLineHandled={consumeFocusLine}
            onChromeActionsChange={setBudgetActions}
            onCategoryCreated={(category) => {
              setCategories((prev) => [...prev, category].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
            }}
          />
        ) : transactions.length === 0 ? (
          <EmptyState
            icon="receipt_long"
            title="Aucune opération"
            message="Ajoute la première écriture pour ce sous-compte."
            action={
              <Button type="button" fullWidth={false} className="mt-2 w-auto px-4" onClick={openCreate}>
                Nouvelle opération
              </Button>
            }
          />
        ) : (
          <div
            className="min-h-0 flex-1 overflow-auto rounded-panel border border-border-subtle bg-elevated"
            data-app-scroll
          >
            <table className="w-full min-w-[32rem] table-fixed border-separate border-spacing-0 text-left md:min-w-[44rem]">
              <colgroup>
                <col className="w-[7rem] md:w-[8rem]" />
                <col className="w-[7rem] md:w-[8rem]" />
                <col className="w-12" />
                <col className="w-16" />
                <col />
                <col className="w-[9rem] md:w-[11rem]" />
                <col className="w-[6rem] md:w-[6.5rem]" />
                <col className="w-[6.5rem]" />
                <col className="w-[7rem] md:w-[8.75rem]" />
              </colgroup>
              <thead>
                <tr className="text-control text-fg-muted">
                  <th
                    scope="col"
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-border-subtle bg-subtle px-2 py-2.5 text-left font-semibold sm:px-3"
                  >
                    Date opération
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-border-subtle bg-subtle px-2 py-2.5 text-center font-semibold sm:px-3"
                  >
                    Date effective
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 hidden whitespace-nowrap border-b border-border-subtle bg-subtle px-1 py-2.5 text-center font-semibold md:table-cell"
                  >
                    Mode
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 hidden whitespace-nowrap border-b border-border-subtle bg-subtle px-1 py-2.5 text-center font-semibold md:table-cell"
                  >
                    Enseigne
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 border-b border-border-subtle bg-subtle px-2 py-2.5 text-left font-semibold sm:px-3"
                  >
                    Libellé
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 border-b border-border-subtle bg-subtle px-2 py-2.5 text-center font-semibold sm:px-3"
                  >
                    Catégorie
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 whitespace-nowrap border-b border-border-subtle bg-subtle px-2 py-2.5 text-center font-semibold sm:px-3"
                  >
                    Montant
                  </th>
                  <th
                    scope="col"
                    className="sticky top-0 z-10 hidden whitespace-nowrap border-b border-border-subtle bg-subtle px-2 py-2.5 text-center font-semibold md:table-cell sm:px-3"
                  >
                    Solde
                  </th>
                  <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-subtle px-1 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => {
                  const methodLabel = PAYMENT_METHOD_LABELS[tx.paymentMethod];
                  const methodTooltip = tx.checkNumber ? `${methodLabel} n°${tx.checkNumber}` : methodLabel;

                  return (
                    <tr
                      key={tx.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Modifier ${tx.designation}`}
                      className="cursor-pointer border-b border-border-subtle last:border-b-0 hover:bg-subtle/40"
                      onClick={() => openEdit(tx)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        openEdit(tx);
                      }}
                    >
                      <td className="whitespace-nowrap px-2 py-2.5 text-left align-middle text-control text-fg-secondary sm:px-3">
                        {formatIsoDateFr(tx.operationDate, { weekday: 'short' })}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-center align-middle text-control sm:px-3">
                        {tx.effectiveDate ? (
                          <span className="text-fg-secondary">
                            {formatIsoDateFr(tx.effectiveDate, { weekday: 'short' })}
                          </span>
                        ) : (
                          <Tooltip content="En attente">
                            <span className="inline-flex size-7 items-center justify-center rounded-full bg-accent-tint text-accent-press">
                              <Icon name="hourglass_empty" className="!text-icon-sm" />
                              <span className="sr-only">En attente</span>
                            </span>
                          </Tooltip>
                        )}
                      </td>
                      <td className="hidden px-1 py-2.5 text-center align-middle md:table-cell">
                        <Tooltip content={methodTooltip}>
                          <span className="inline-flex size-7 items-center justify-center rounded-full text-fg-secondary">
                            <Icon name={PAYMENT_METHOD_ICONS[tx.paymentMethod]} className="text-icon-sm" />
                            <span className="sr-only">{methodTooltip}</span>
                          </span>
                        </Tooltip>
                      </td>
                      <td className="hidden px-1 py-2.5 text-center align-middle md:table-cell">
                        {tx.merchant ? (
                          <Tooltip content={tx.merchant.name}>
                            <MerchantVisual
                              name={tx.merchant.name}
                              color={tx.merchant.color}
                              icon={tx.merchant.icon}
                              imageUrl={tx.merchant.imageUrl}
                              className="mx-auto size-7 rounded-full"
                              iconClassName="text-[13px]!"
                              showNativeTitle={false}
                            />
                          </Tooltip>
                        ) : (
                          <span className="text-control text-fg-muted">—</span>
                        )}
                      </td>
                      <td className="min-w-0 px-2 py-2.5 text-left align-middle sm:px-3">
                        <p className="truncate text-body font-medium text-fg-primary" title={tx.designation}>
                          {tx.designation}
                        </p>
                      </td>
                      <td className="px-2 py-2.5 text-center align-middle sm:px-3">
                        <CategoryChip
                          name={tx.category.name}
                          color={tx.category.color}
                          icon={tx.category.icon}
                          className="w-full"
                        />
                      </td>
                      <td
                        className={cn(
                          'whitespace-nowrap px-2 py-2.5 text-center align-middle text-body font-semibold tabular-nums sm:px-3',
                          signedAmountClass(tx.amountCents),
                        )}
                      >
                        {formatCents(tx.amountCents)}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2.5 text-right align-middle text-control tabular-nums md:table-cell sm:px-3">
                        {tx.effectiveDate ? (
                          <span className={signedAmountClass(tx.balanceAfterCents ?? 0)}>
                            {formatCents(tx.balanceAfterCents ?? 0)}
                          </span>
                        ) : (
                          <Tooltip content="Solde provisoire (opération en attente)">
                            <span className="inline-flex items-center justify-center rounded-full bg-accent-tint px-2.5 py-0.5 font-medium text-accent-press">
                              {formatCents(tx.balanceAfterCents ?? 0)}
                            </span>
                          </Tooltip>
                        )}
                      </td>
                      <td
                        className="cursor-default whitespace-nowrap px-1 py-2.5 align-middle"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <div className="flex justify-end gap-0.5">
                          {tx.hasAttachment ? (
                            <Tooltip
                              content={
                                tx.attachmentOriginalName
                                  ? `Pièce jointe : ${tx.attachmentOriginalName}`
                                  : 'Ouvrir la pièce jointe'
                              }
                            >
                              <IconButton
                                variant={ICON_BUTTON_VARIANT.soft}
                                icon="attach_file"
                                aria-label={
                                  tx.attachmentOriginalName
                                    ? `Ouvrir ${tx.attachmentOriginalName}`
                                    : 'Ouvrir la pièce jointe'
                                }
                                onClick={() => void openAttachment(tx)}
                              />
                            </Tooltip>
                          ) : null}
                          <Tooltip content="Modifier">
                            <IconButton
                              variant={ICON_BUTTON_VARIANT.soft}
                              icon="edit"
                              aria-label="Modifier"
                              onClick={() => openEdit(tx)}
                            />
                          </Tooltip>
                          <Tooltip content="Supprimer">
                            <IconButton
                              variant={ICON_BUTTON_VARIANT.danger}
                              icon="delete"
                              aria-label="Supprimer"
                              onClick={() => setPendingDelete(tx)}
                            />
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {ledger.hasMore ? (
              <div
                ref={loadMoreSentinelRef}
                className="flex items-center justify-center py-3"
                aria-hidden={!loadingMore}
              >
                {loadingMore ? <p className="text-control text-fg-muted">Chargement…</p> : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Dialog
        isOpen={dialogOpen}
        onClose={closeForm}
        title={editing ? 'Modifier l’opération' : 'Nouvelle opération'}
        size={DIALOG_SIZE.wide}
      >
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              <FormField label="Désignation" htmlFor="tx-designation">
                <input
                  id="tx-designation"
                  className={FIELD_CONTROL_CLASSES}
                  placeholder="Ex. Courses Carrefour"
                  {...form.register('designation', { required: true })}
                />
              </FormField>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Date d’opération" htmlFor="tx-op">
                  <DateField
                    id="tx-op"
                    value={form.watch('operationDate')}
                    onChange={(next) =>
                      form.setValue('operationDate', next, { shouldDirty: true, shouldValidate: true })
                    }
                  />
                  <input type="hidden" {...form.register('operationDate', { required: true })} />
                </FormField>
                <FormField
                  label="Date effective"
                  htmlFor="tx-eff"
                  action={
                    form.watch('effectiveDate') ? (
                      <button
                        type="button"
                        className="text-control text-accent hover:underline"
                        onClick={() => form.setValue('effectiveDate', '', { shouldDirty: true })}
                      >
                        Effacer
                      </button>
                    ) : null
                  }
                >
                  <DateField
                    id="tx-eff"
                    value={form.watch('effectiveDate')}
                    onChange={(next) => form.setValue('effectiveDate', next, { shouldDirty: true })}
                    placeholder="Optionnel"
                  />
                  <input type="hidden" {...form.register('effectiveDate')} />
                </FormField>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Catégorie" htmlFor="tx-category">
                  <Select
                    id="tx-category"
                    label="Catégorie"
                    placeholder="Choisir une catégorie"
                    searchPlaceholder="Rechercher une catégorie…"
                    value={categoryId}
                    onChange={(next) => {
                      form.setValue('categoryId', next, { shouldDirty: true, shouldValidate: true });
                      const nextCategory = categories.find((category) => category.id === next);
                      form.setValue('merchantId', favoriteMerchantIdForCategory(nextCategory), {
                        shouldDirty: true,
                      });
                    }}
                    options={buildCategorySelectOptions(categories)}
                    createOption={{
                      label: 'Nouvelle catégorie',
                      onCreate: () => setCategoryCreateOpen(true),
                    }}
                  />
                  <input type="hidden" {...form.register('categoryId', { required: true })} />
                </FormField>

                <FormField label="Enseigne" htmlFor="tx-merchant">
                  <Select
                    id="tx-merchant"
                    label="Enseigne"
                    searchPlaceholder="Rechercher une enseigne…"
                    value={merchantId}
                    onChange={(next) => form.setValue('merchantId', next, { shouldDirty: true })}
                    options={buildMerchantSelectOptions(merchants, selectedCategory ?? undefined)}
                    createOption={{
                      label: 'Nouvelle enseigne',
                      onCreate: () => setMerchantCreateOpen(true),
                    }}
                  />
                  <input type="hidden" {...form.register('merchantId')} />
                </FormField>
              </div>

              {selectedCategory?.kind === 'both' && (
                <FormField label="Sens">
                  <ChoiceCards
                    label="Sens"
                    className="grid grid-cols-2 gap-2"
                    value={flow}
                    options={[
                      { value: 'debit', label: 'Débit (−)', icon: 'arrow_downward' },
                      { value: 'credit', label: 'Crédit (+)', icon: 'arrow_upward' },
                    ]}
                    onChange={(next) => form.setValue('flow', next, { shouldDirty: true })}
                  />
                </FormField>
              )}

              <FormField label="Pièce jointe" htmlFor="tx-attachment-file">
                {showExistingAttachment ? (
                  <div className="flex min-h-24 items-center gap-2 rounded-control border border-border-subtle bg-elevated/50 px-3 py-2.5 text-control text-fg-secondary">
                    <Icon name="attach_file" className="text-icon-sm shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{editing?.attachmentOriginalName ?? 'Pièce jointe'}</span>
                    <button
                      type="button"
                      className="shrink-0 text-accent hover:underline"
                      onClick={() => setRemoveAttachment(true)}
                    >
                      Retirer
                    </button>
                  </div>
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Ajouter une photo ou un fichier"
                    onClick={() => attachmentInputRef.current?.click()}
                    onKeyDown={onAttachmentDropzoneKeyDown}
                    onDragOver={onAttachmentDragOver}
                    onDragEnter={onAttachmentDragOver}
                    onDragLeave={onAttachmentDragLeave}
                    onDrop={onAttachmentDrop}
                    className={cn(
                      'flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-control border border-dashed px-4 py-4 transition-colors',
                      attachmentDragging
                        ? 'border-accent bg-accent-tint/40'
                        : 'border-border-subtle bg-elevated/40 hover:border-accent/60',
                    )}
                  >
                    {attachmentFile ? (
                      <div className="flex w-full items-center gap-2 text-left">
                        <Icon name="attach_file" className="text-icon shrink-0 text-accent" />
                        <span className="min-w-0 flex-1 truncate text-control text-fg-secondary">
                          {attachmentFile.name}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 text-control text-accent hover:underline"
                          onClick={(event) => {
                            event.stopPropagation();
                            pickAttachment(null);
                          }}
                        >
                          Retirer
                        </button>
                      </div>
                    ) : (
                      <>
                        <Icon name="upload_file" className="text-3xl text-fg-muted" />
                        <p className="m-0 text-center text-control text-fg-secondary">Photo ou PDF</p>
                      </>
                    )}
                    <input
                      ref={attachmentInputRef}
                      id="tx-attachment-file"
                      type="file"
                      accept={ATTACHMENT_ACCEPT}
                      className="sr-only"
                      onChange={onAttachmentChange}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </div>
                )}
              </FormField>
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <FormField label="Mode de paiement">
                <ChoiceCards
                  label="Mode de paiement"
                  className="grid grid-cols-2 gap-2"
                  value={paymentMethod}
                  options={PAYMENT_METHODS.map((method) => ({
                    value: method,
                    label: PAYMENT_METHOD_LABELS[method],
                    icon: PAYMENT_METHOD_ICONS[method],
                  }))}
                  onChange={(method) => form.setValue('paymentMethod', method, { shouldDirty: true })}
                />
              </FormField>

              {paymentMethod === 'check' && (
                <FormField label="N° de chèque" htmlFor="tx-check">
                  <input
                    id="tx-check"
                    className={FIELD_CONTROL_CLASSES}
                    {...form.register('checkNumber', { required: paymentMethod === 'check' })}
                  />
                </FormField>
              )}

              <FormField label="Montant" htmlFor="tx-amount">
                <div className="relative flex min-h-28 items-stretch overflow-hidden rounded-control border border-border bg-page transition-[border-color,box-shadow] duration-(--duration-fast) focus-within:border-accent focus-within:shadow-[var(--focus-ring)] hover:border-border-strong dark:bg-elevated">
                  <Controller
                    name="amount"
                    control={form.control}
                    rules={{ required: true }}
                    render={({ field }) => (
                      <TpeAmountInput
                        id="tx-amount"
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        className={cn(
                          'min-w-0 flex-1 border-0 bg-transparent px-10 py-3 text-center text-[2rem] leading-none font-bold tabular-nums outline-none',
                          amountToneClass,
                        )}
                      />
                    )}
                  />
                  <span
                    className={cn(
                      'pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[1.75rem] font-semibold tabular-nums',
                      amountToneClass,
                    )}
                    aria-hidden="true"
                  >
                    €
                  </span>
                </div>
              </FormField>
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:flex-wrap">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={BUTTON_VARIANT.dangerOutline}
                fullWidth={false}
                className="w-auto px-3"
                onClick={closeForm}
              >
                Annuler
              </Button>
              {form.formState.isDirty || attachmentFile || removeAttachment ? (
                <Button
                  type="button"
                  variant={BUTTON_VARIANT.neutral}
                  fullWidth={false}
                  className="w-auto px-3"
                  onClick={resetTransactionForm}
                >
                  Réinitialiser
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 sm:ms-auto sm:flex-row sm:flex-wrap">
              {creating ? (
                <Button
                  type="button"
                  variant={BUTTON_VARIANT.successOutline}
                  fullWidth={false}
                  className="w-full px-3 sm:w-auto"
                  loading={form.formState.isSubmitting}
                  onClick={() => void onSubmitAndNew()}
                >
                  Enregistrer et continuer
                </Button>
              ) : null}
              <Button
                type="submit"
                variant={BUTTON_VARIANT.success}
                fullWidth={false}
                className="w-full px-4 sm:w-auto"
                loading={form.formState.isSubmitting}
              >
                Enregistrer
              </Button>
            </div>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void onDelete()}
        title="Supprimer l’opération"
        message={pendingDelete ? `Supprimer « ${pendingDelete.designation} » ? Cette action est définitive.` : ''}
        confirmLabel="Supprimer"
        confirmVariant={BUTTON_VARIANT.danger}
        busy={deleteBusy}
      />

      <CategoryQuickCreate
        open={categoryCreateOpen}
        onClose={() => setCategoryCreateOpen(false)}
        onCreated={(category) => {
          setCategories((prev) => [...prev, category].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
          form.setValue('categoryId', category.id);
          form.setValue('merchantId', favoriteMerchantIdForCategory(category));
        }}
      />

      <MerchantQuickCreate
        open={merchantCreateOpen}
        onClose={() => setMerchantCreateOpen(false)}
        onCreated={(merchant: Merchant) => {
          setMerchants((prev) => [...prev, merchant].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
          form.setValue('merchantId', merchant.id);
        }}
      />
    </div>
  );
}
