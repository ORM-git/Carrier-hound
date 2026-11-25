// @vitest-environment jsdom
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import Footer from '../Footer';

vi.mock('next/navigation', () => ({ usePathname: () => '/resume' }));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch, ...p }: any) => (
    <a href={href} {...p}>{children}</a>
  ),
}));

afterEach(cleanup);

describe('public footer', () => {
  it('uses the Information heading and retains every navigation and legal destination', () => {
    render(<Footer />);
    expect(screen.getByRole('heading', { name: 'Information' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Legal' })).toBeNull();
    const links: Array<[string, string]> = [
      ['Live Job Search', '/jobs'],
      ['Worldwide Remote', '/worldwide'],
      ['3D Job Radar', '/radar'],
      ['Remote Guides', '/remote'],
      ['Applications Tracker', '/tracker'],
      ['Pricing & Plans', '/pricing'],
      ['Log In', '/login'],
      ['Get Started', '/signup'],
      ['Privacy Policy', '/privacy-policy'],
      ['Terms & Conditions', '/terms-and-conditions'],
      ['Cancellation & Refund Policy', '/refund-policy'],
      ['Cookie Notice', '/privacy'],
    ];
    for (const [name, href] of links) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(href);
    }
  });

  it('reserves the measured cookie notice height at the bottom', () => {
    const { container } = render(<Footer />);
    const cls = container.querySelector('footer')?.className ?? '';
    expect(cls).toContain('--cm-cookie-notice-height');
  });

  it('keeps the four link groups in one container with the mobile two-column and desktop four-column tokens', () => {
    render(<Footer />);
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(4);
    const groups = headings.map((h) => h.parentElement as HTMLElement);
    const container = groups[0].parentElement as HTMLElement;
    for (const group of groups) expect(group.parentElement).toBe(container);
    const tokens = container.className.split(/\s+/);
    for (const token of ['columns-2', 'md:columns-auto', 'md:grid', 'md:grid-cols-4']) {
      expect(tokens).toContain(token);
    }
  });
});
