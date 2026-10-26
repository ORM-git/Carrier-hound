export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  date: string;
  salary: string;
  category: string;
  remote: boolean;
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
