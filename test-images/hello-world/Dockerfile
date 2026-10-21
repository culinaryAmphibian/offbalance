# Test job image: prints "hello world" and writes it to /output/result.txt.
# Providers hash only /output (stdout is ignored), so every honest provider
# that runs this image commits the same result hash.
#
# Self-contained (no COPY), so it also works as a JSON {"dockerfile": ...} build
# through the server's POST /builds.
FROM alpine:3.20
RUN printf '#!/bin/sh\nset -eu\necho "hello world"\n# the provider client mounts the job output folder at /output\n[ -d /output ] && echo "hello world" > /output/result.txt\nexit 0\n' > /usr/local/bin/hello \
 && chmod +x /usr/local/bin/hello
CMD ["hello"]
