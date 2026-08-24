# Zero-state task board

Build a complete local task-board web application from an empty Git repository.

## Product behavior

- Users can create non-empty tasks and see them immediately.
- Users can complete, restore, and remove tasks.
- Tasks and completion state survive a browser reload.
- Invalid persisted data does not prevent the app from starting.

## Runtime contract

- Use Node.js 22 and browser-native APIs.
- `npm start` launches the application on localhost and prints its URL.
- `npm test` runs deterministic automated checks.
- The application must not require an external service.
- The initial scaffold must establish all package scripts needed by later tickets.
- Application code belongs under `src/` or `public/`; deterministic checks belong under `test/`.

## Quality bar

- The primary workflow is usable with a keyboard and has visible labels.
- Empty task submission is rejected without losing the current task list.
- Later tickets preserve every previously accepted behavior.
