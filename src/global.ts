/**
 * The `<script>` build: everything in the package, as the global `BloomsImagine`.
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@bloomscorp/imagine.js@0.1.0/dist/imagine.global.js"></script>
 *   const imagine = new BloomsImagine.ImagineBrowser({ getSessionToken });
 */
export {ImagineBrowser, ImagineError, isImagineError, VERSION} from './index';
