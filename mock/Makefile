CC      = gcc
CFLAGS  = -shared -fPIC -O2 -Wall -Wextra -std=c11
TARGET  = libapv-mock.so
SRC     = libapv-mock.c

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $<
	@echo "Built $(TARGET)"

clean:
	rm -f $(TARGET)
