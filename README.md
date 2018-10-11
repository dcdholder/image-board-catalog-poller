# Image Board Catalog Poller

A service for pushing relevant image board thread links/data to webhook "subscribers". Polls board catalogs for OP contents/subjects matching provided search strings.

May include chat client integration later on.

## Implementation

Implemented with AWS serverless components (scheduled/HTTP Lambdas, DynamoDB, S3).
