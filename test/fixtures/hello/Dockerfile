FROM busybox:1.37.0
WORKDIR /www
COPY index.html .
EXPOSE 8080
CMD ["sh", "-c", "env | sort | sed -n '/^HOIST_TEST_[A-Z0-9_]*=/p' > /www/env; echo 'httpd listening on 8080'; exec httpd -f -p 8080 -h /www"]
