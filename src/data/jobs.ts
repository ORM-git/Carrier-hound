export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  date: string;
  salary: string;
  category: string;
  role_category?: string | null;
  company_category?: string | null;
  top_keywords?: string[];
  remote: boolean;
  is_remote?: boolean;
  country: string;
  type: string;
  directSource: boolean;
  applyUrl: string;
  description?: string;
  skills?: string[];
  remoteScope?: string;
  remoteEligibility?: string;
}

export const DUMMY_JOBS: Job[] = [];
