# DNS certificate renewal options

Reviewed 2026-10-17 for `tayynhyzmat.bagtyyar.dev`. This is a plan, not installed renewal automation. Production HTTP-01 and TLS-ALPN-01 attempts failed CA secondary validation. Initial manual DNS-01 succeeded after the owner's Namecheap TXT change; the certificate expires 2027-01-15. Production selects external certificate mode. Renewal still requires an operator until automation is tested.

## Use manual DNS validation for the initial certificate

DNS-01 proves control using a TXT record at `_acme-challenge.tayynhyzmat.bagtyyar.dev`. It does not require the CA to reach the application's ports 80 or 443. The ACME client still needs its CA connection and the TXT record must be publicly resolvable. The current prompt's value must be checked before continuing; restarting the request can change it. [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)

Manual DNS validation does not establish unattended renewal. A renewal client needs a working DNS update integration or an operator for each challenge. Until automation is reviewed and tested, keep expiry monitoring and an operator renewal reminder. Certbot supports manual authentication hooks, but a timer without a functional hook cannot perform manual DNS changes. [Certbot manual plugin](https://eff-certbot.readthedocs.io/en/stable/using.html#manual)

## Option 1: use Namecheap's API

Namecheap documents API access eligibility as at least 20 domains, a $50 account balance, or $50 spent in the previous two years; support may consider exceptions. API access must be enabled and at least one IPv4 address whitelisted. A stable outbound IPv4 makes scheduled operation easier; verify the actual renewal runner's egress address and API reachability first. These account permissions and credentials have not been checked for the owner. [Namecheap API FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/), [API introduction](https://www.namecheap.com/support/api/intro/)

The main risk is DNS record preservation. Namecheap's `setHosts` operation deletes records omitted from the request. An integration must preserve every existing record and account for concurrent changes, including the root website and mail records. Do not give an unreviewed script a broad DNS key or assume it can update one TXT record independently. [Namecheap setHosts](https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/)

This option avoids changing DNS delegation, but needs API eligibility, a suitable renewal client, protected credentials and a successful staging renewal test that proves unrelated records remain intact. The stock Caddy configuration in this repository does not include a Namecheap DNS integration.

## Option 2: delegate only the validation name

Let's Encrypt follows CNAME or NS delegation for DNS-01. A permanent delegation for `_acme-challenge.tayynhyzmat.bagtyyar.dev` can point to a separate validation zone whose provider has an appropriate API. This preserves Namecheap's application A record, root website and mail records. Configure the renewal client to update the delegated destination explicitly; the CA following an alias does not configure the client's DNS updater. [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/)

An existing trusted acme-dns service is another option. Its credentials permit updates to a dedicated generated TXT name, limiting the DNS access exposed to the renewal client. Self-hosting acme-dns adds a publicly reachable DNS service, HTTPS API, storage and maintenance; it is not the simplest first-release addition under the current network restrictions. A third-party service introduces its own availability and trust dependency. [acme-dns project and protocol](https://github.com/joohoi/acme-dns)

## Recommendation and acceptance checks

Keep the successfully issued manual DNS-01 certificate for the initial release. For unattended renewal, prefer delegating only the validation name to an existing API-capable DNS service with narrowly scoped credentials, if the owner has or chooses one. Namecheap API is a reasonable alternative after eligibility and the complete-record update behavior are verified. Neither choice has been provisioned; no new service, DNS delegation or API credential is assumed.

Before relying on either option:

- Confirm DNS provider ownership, API reachability and credential scope from the intended renewal runner.
- Review the client/plugin and test against the CA's staging service while keeping existing production DNS records intact.
- Prove unattended TXT creation, propagation, cleanup and a subsequent renewal run.
- Install the resulting certificate and key through protected files, recreate only the external-mode Caddy proxy and verify public hostname/chain/expiry.
- Record the responsible operator, renewal schedule, key locations and expiry alerts in the production handoff. Preserve SSH and the previous certificate throughout.

Do not disable certificate verification, automate repeated failing ACME requests or describe manual issuance as automatic renewal.
