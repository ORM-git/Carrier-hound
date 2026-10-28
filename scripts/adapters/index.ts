import { SourceAdapter } from './types';
import { SourceType } from '../types';
import { GreenhouseAdapter } from './greenhouse';
import { LeverAdapter } from './lever';
import { AshbyAdapter } from './ashby';
import { SmartRecruitersAdapter } from './smartrecruiters';
import { RecruiteeAdapter } from './recruitee';
import { WorkableAdapter } from './workable';
import { BreezyAdapter } from './breezy';
import { TeamtailorAdapter } from './teamtailor';
import { PersonioAdapter } from './personio';
import { RemotiveAdapter } from './remotive';
import { ArbeitnowAdapter } from './arbeitnow';
import { RemoteOKAdapter } from './remoteok';
import { WeWorkRemotelyAdapter } from './weworkremotely';
import { AdzunaAdapter } from './adzuna';

const adapterRegistry: Record<string, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  lever: new LeverAdapter(),
  ashby: new AshbyAdapter(),
  smartrecruiters: new SmartRecruitersAdapter(),
  recruitee: new RecruiteeAdapter(),
  workable: new WorkableAdapter(),
  breezy: new BreezyAdapter(),
  teamtailor: new TeamtailorAdapter(),
  personio: new PersonioAdapter(),
  adzuna: new AdzunaAdapter(),
  remotive: new RemotiveAdapter(),
  arbeitnow: new ArbeitnowAdapter(),
  remoteok: new RemoteOKAdapter(),
  weworkremotely: new WeWorkRemotelyAdapter(),
};

export function getAdapter(type: SourceType): SourceAdapter | null {
  return adapterRegistry[type] || null;
}

export {
  GreenhouseAdapter,
  LeverAdapter,
  AshbyAdapter,
  SmartRecruitersAdapter,
  RecruiteeAdapter,
  WorkableAdapter,
  BreezyAdapter,
  TeamtailorAdapter,
  PersonioAdapter,
  AdzunaAdapter,
  RemotiveAdapter,
  ArbeitnowAdapter,
  RemoteOKAdapter,
  WeWorkRemotelyAdapter,
};
