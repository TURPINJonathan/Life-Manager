import type { AUTH_STATUS } from '@constants';

export type AuthStatus = (typeof AUTH_STATUS)[keyof typeof AUTH_STATUS];

export type AuthUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
};

export type { INavItem } from './navigation.types';
export type {
  Account,
  Category,
  CategoryKind,
  CategoryMonthTransactionsPayload,
  ForecastLine,
  ForecastLineInput,
  ForecastStats,
  ForecastStatsCategory,
  ForecastStatsPreviousCategory,
  ForecastStatsPreviousLine,
  ForecastTimelinePoint,
  LedgerPayload,
  LedgerTransaction,
  Merchant,
  MonthlyForecast,
  PaymentMethod,
  SubAccount,
} from './finance.types';
export type {
  ButtonVariant,
  DialogSize,
  IconButtonVariant,
  LogoVariant,
  NavItemVariant,
  PopoverPlacement,
  SelectOption,
  SpinnerVariant,
  TypographyElement,
  TypographyVariant,
  TypographyWeight,
  UserTheme,
} from './ui.types';
export type {
  ContractType,
  ContributionSuggestion,
  JobStatus,
  NetEstimateMode,
  TimeEntry,
  TimeSegmentInput,
  TimeShortcut,
  TimeStats,
  TimeStatsSummary,
  TimeWeekStats,
  WorkDashboard,
  WorkDashboardJobRow,
  WorkDashboardTimelinePoint,
  WorkDashboardWorker,
  WorkDocument,
  WorkDocumentKind,
  WorkJob,
  WorkJobSummary,
  WeekTemplate,
  WeekTemplateDay,
  WorkPlanEntry,
  Worker,
} from './work.types';
