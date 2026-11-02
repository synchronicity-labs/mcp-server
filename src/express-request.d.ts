import type { AuthInfo } from '@modelcontextprotocol/server';

// The bearer middleware sets req.auth. The SDK's own augmentation targets
// express-serve-static-core, which its types cannot resolve under pnpm's global
// virtual store, so declare the field on Express's global Request as well.
declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}
