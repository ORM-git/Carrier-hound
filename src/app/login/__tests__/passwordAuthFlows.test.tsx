// @vitest-environment jsdom
import React from 'react';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
const mocks=vi.hoisted(()=>({password:vi.fn(),signup:vi.fn(),google:vi.fn(),replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:mocks.replace,push:vi.fn()})}));
vi.mock('@/components/GuideHeader',()=>({default:()=>null}));vi.mock('@/components/Footer',()=>({default:()=>null}));
vi.mock('@/lib/auth/session',()=>({getAuthUser:async()=>null,getValidReturnUrl:(s:any,f:any)=>f}));
vi.mock('@/lib/supabase/client',()=>({createClient:()=>({auth:{signInWithPassword:mocks.password,signUp:mocks.signup,signInWithOAuth:mocks.google}})}));
vi.mock('@/lib/analytics/funnel',()=>({trackFunnelEvent:vi.fn()}));
import Login from '../page';import Signup from '../../signup/page';
afterEach(()=>{cleanup();vi.clearAllMocks()});
function fill(){fireEvent.change(screen.getByLabelText('Email'),{target:{value:'fixture@example.test'}});fireEvent.change(screen.getByLabelText(/^Password/),{target:{value:'valid-password'}});}
describe('real password form handlers, isolated SDK',()=>{
 it('submits password, not OTP, and routes through shared callback',async()=>{mocks.password.mockResolvedValue({error:null});render(<Login/>);fill();fireEvent.submit(screen.getByLabelText('Email').closest('form')!);await waitFor(()=>expect(mocks.replace).toHaveBeenCalledWith('/auth/callback?returnTo=%2Fjobs'));expect(mocks.password).toHaveBeenCalledWith({email:'fixture@example.test',password:'valid-password'});expect(screen.queryByText(/email me a sign.in link/i)).toBeNull();});
 it.each([{code:'invalid_credentials'},{code:'email_not_confirmed'},{status:429}])('handles auth errors without navigating %j',async(error)=>{mocks.password.mockResolvedValue({error});render(<Login/>);fill();fireEvent.submit(screen.getByLabelText('Email').closest('form')!);await waitFor(()=>expect(screen.getByRole('alert')).toBeTruthy());expect(mocks.replace).not.toHaveBeenCalled();});
 it('signs up with a password and shows verification rather than magic link login',async()=>{mocks.signup.mockResolvedValue({data:{session:null},error:null});render(<Signup/>);fill();fireEvent.submit(screen.getByLabelText('Email').closest('form')!);await waitFor(()=>expect(mocks.signup).toHaveBeenCalled());expect(mocks.signup.mock.calls[0][0].password).toBe('valid-password');expect(mocks.replace).not.toHaveBeenCalled();});
});
