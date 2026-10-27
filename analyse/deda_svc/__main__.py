# SPDX-License-Identifier: GPL-3.0-or-later
import logging
import os

from .server import serve

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
srv = serve(int(os.environ.get("PORT", "8770")))
logging.getLogger(__name__).info("listening on port %d", srv.server_address[1])
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    srv.server_close()
