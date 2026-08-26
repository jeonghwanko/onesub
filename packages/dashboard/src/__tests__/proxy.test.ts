import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '../../proxy';
import { COOKIE_NAME } from '../../lib/session-constants';

describe('dashboard proxy guard', () => {
  it('redirects a dashboard request without a session cookie', () => {
    const response = proxy(new NextRequest('https://dashboard.example.test/dashboard/customers'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://dashboard.example.test/login');
  });

  it('allows a dashboard request with a session envelope', () => {
    const request = new NextRequest('https://dashboard.example.test/dashboard', {
      headers: { cookie: `${COOKIE_NAME}=opaque-session-envelope` },
    });

    expect(proxy(request).headers.get('location')).toBeNull();
  });
});
