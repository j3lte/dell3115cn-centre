# SPDX-License-Identifier: GPL-3.0-or-later
import logging
import os

from .logsetup import setup_logging
from .server import serve

setup_logging(os.environ)
srv = serve(int(os.environ.get("PORT", "8770")))
logging.getLogger("deda_svc").info("listening on port %d", srv.server_address[1])
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    srv.server_close()
