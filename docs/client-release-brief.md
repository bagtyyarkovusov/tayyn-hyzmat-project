# Tayyn Hyzmat — Client Progress Brief

**Status:** Development release candidate  
**Date:** 16 October 2026

Tayyn Hyzmat has moved from the legacy prototype to a stable, testable dispatch and driver experience.

## What is working now

- Dispatchers can create orders, choose a private driver offer, and decide whether an unanswered offer should become available to all drivers.
- Drivers receive offers clearly, with a fixed 20-second response window. The first driver to accept gets the order, and other screens update immediately.
- Driver balances are protected: an order cannot be accepted when its price is higher than the available balance, and balances cannot go below zero.
- The dispatcher view now makes active drivers easier to find, with search, filters, map context, and a compact layout for larger teams.
- GPS, driver availability, and connection states are being separated so drivers and dispatchers can tell whether location is ready, whether the driver is live, and whether the connection is healthy.
- Trips remain assigned during a short connection problem. Dispatchers can see trips that have been waiting too long for completion and resolve them with a recorded reason.
- The driver offer screen, mobile layout, branding, phone fields, and login experience have been cleaned up for everyday phone use.

## Confidence from testing

The main order journeys have been exercised in the Android simulator, including public orders, private offers, the 20-second response window, competing driver acceptance, payment protection, refunds, arrival, waiting, and cancellation. The latest build was installed locally and the shared Railway deployment is healthy.

## What remains before production release

- Complete the final Android 14 test on the physical Infinix phone, including locked-screen behavior, background operation, and audible notifications.
- Finish the remaining readiness and public-offer edge-case checks, then publish the corresponding Android build.
- Confirm production Yandex credentials and quota settings for optional address names. GPS and region eligibility continue to work if address lookup is unavailable.
- Complete the final mobile login and small-screen visual check, then run the release checklist against the production configuration.

The team will keep the shared region boundaries intact while these final checks are completed.
