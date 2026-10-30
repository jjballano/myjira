export type StatusCategory = 'new' | 'indeterminate' | 'done';

export interface User {
  accountId: string;
  displayName: string;
  avatar?: string;
}

export interface Me extends User {
  baseUrl: string;
  /** Signed in through the login form (vs. the server's .env token). */
  session: boolean;
}

export interface Status {
  id: string;
  name: string;
  category: StatusCategory;
}

export interface IssueType {
  name: string;
  icon?: string;
  subtask: boolean;
  hierarchyLevel: number;
}

export interface ParentRef {
  key: string;
  summary: string;
  status: Status | null;
  issuetype: IssueType | null;
}

export interface Issue {
  id: string;
  key: string;
  summary: string;
  status: Status | null;
  assignee: User | null;
  issuetype: IssueType | null;
  priority: { name: string; icon?: string } | null;
  parent: ParentRef | null;
  labels: string[];
  updated: string;
}

export interface Sprint {
  id: number;
  name: string;
  state: 'active' | 'future' | 'closed';
  startDate?: string;
  endDate?: string;
  goal?: string;
  originBoardId?: number;
}

export interface Board {
  id: number;
  name: string;
  type: string;
  projectKey?: string;
}

export interface Column {
  name: string;
  statusIds: string[];
  /** Parallel to `statusIds`. */
  statusNames?: string[];
  /** Set when this column is one status of a board column split apart. */
  splitFrom?: string;
}

export interface Transition {
  id: string;
  name: string;
  to: Status;
}

export interface Comment {
  id: string;
  author: User | null;
  created: string;
  bodyHtml: string;
}

export interface IssueDetail extends Issue {
  description: string;
  descriptionHtml: string;
  reporter: User | null;
  timetracking: {
    originalEstimate?: string;
    remainingEstimate?: string;
    timeSpent?: string;
  };
  project: { key: string; name: string };
  sprint: Sprint | null;
  url: string;
  comments: Comment[];
}

export interface IssuePatch {
  summary?: string;
  description?: string;
  labels?: string[];
  parent?: string | null;
  assignee?: string | null;
  /** priority id */
  priority?: string;
}

export interface Priority {
  id: string;
  name: string;
  icon?: string;
}
