# Accounts and access

Email-and-password accounts, created in the app. No outside identity provider.

## How it works
- **Sign up:** anyone who can reach the app can create an account (any email address) unless you restrict it (below).
- **First account = admin.** The first person to sign up becomes the admin and inherits any work created before accounts existed. Admins see the **Research data** area (uploads, review queue, study requests, team) and can promote or disable others.
- **Everyone else** is a normal user: their own profile, their own saved work. Answers, plans and assessments are private to their owner (admins can open any, to support the team). The research evidence itself is shared by everyone who is signed in.
- **Passwords** are hashed with scrypt (salted). Minimum 10 characters. Sessions last 14 days, are stored hashed, and use an HttpOnly, SameSite=Lax cookie. Five wrong sign-ins lock that email and address for 15 minutes.
- **Forgotten password:** there is no email service, so an admin resets it under *Research data > Team*. The person gets a temporary password (shown once) and must choose their own at next sign-in. Changing a password signs the person out everywhere else.

## Settings (environment variables)
| Variable | Effect |
|---|---|
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated domains allowed to sign up, e.g. `snapdeal.com`. Empty = anyone. |
| `ADMIN_SETUP_CODE` | If set, the very first sign-up (the admin) must enter this code. Prevents a stranger claiming admin on a freshly deployed server. |
| `COOKIE_SECURE=1` | Set when the app is served over https. |
| `TRUST_PROXY=1` | Set when running behind a reverse proxy, so sign-in throttling sees real client addresses. |
| `HOST` | Address to listen on. Default `127.0.0.1` (this machine only). Use `0.0.0.0` to accept other machines. |

## Before this is reachable by other people
Open sign-up means anyone who can reach the address can create an account and read the research. Before putting it on a shared network or the internet, set `ALLOWED_EMAIL_DOMAINS` (and `ADMIN_SETUP_CODE`), serve it over https and set `COOKIE_SECURE=1`.

## What is recorded
Uploads, approvals/rejections (also stored on each piece of evidence as reviewer and time), study request replies, role changes, password resets and sign-ins are written to the audit log with the person who did them.
