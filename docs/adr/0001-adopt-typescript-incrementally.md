# Adopt backend TypeScript incrementally

Compile the existing CommonJS backend with JavaScript allowed, and use strict TypeScript for converted modules and new tests. Start with region matching and preserve its public behavior, keeping the Vue 2 frontend migration separate to avoid coupling the pilot baseline to a frontend rewrite. Existing JavaScript remains unchecked until deliberately migrated.
