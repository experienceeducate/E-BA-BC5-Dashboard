import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.jsx'

beforeEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('App (unauthenticated)', () => {
  it('shows the guest login screen when there is no stored token', () => {
    render(<App />)
    expect(screen.getByPlaceholderText(/guest password/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue as guest/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /sign in with google/i })).toBeInTheDocument()
  })

  it('shows an error when the guest password is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    render(<App />)

    fireEvent.change(screen.getByPlaceholderText(/guest password/i), {
      target: { value: 'wrong-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    expect(await screen.findByText(/incorrect password/i)).toBeInTheDocument()
  })

  it('stores the JWT and moves past the login screen on success', async () => {
    // ExecutiveSummary fires several concurrent /api/overview/* calls once
    // logged in, on top of /api/auth/login, /api/auth/me and /api/filters —
    // route by URL rather than call order, and 503 everything else so the
    // dashboard falls back to its built-in demo data (see DemoContext).
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (url.includes('/api/auth/login')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'test-jwt' }) })
      }
      if (url.includes('/api/auth/me')) {
        return Promise.resolve({ ok: true, json: async () => ({ role: 'guest', email: null }) })
      }
      return Promise.resolve({ ok: false, status: 503 })
    }))

    render(<App />)
    fireEvent.change(screen.getByPlaceholderText(/guest password/i), {
      target: { value: 'right-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue as guest/i }))

    await waitFor(() => expect(sessionStorage.getItem('eba_token')).toBe('test-jwt'))
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument()
    expect(screen.getByText(/guest view/i)).toBeInTheDocument()
  })
})
