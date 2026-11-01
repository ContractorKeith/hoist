FROM busybox:1.37.0
WORKDIR /www
COPY index.html .
EXPOSE 8080
CMD ["sh", "-c", "echo 'httpd listening on 8080'; exec httpd -f -p 8080 -h /www"]
