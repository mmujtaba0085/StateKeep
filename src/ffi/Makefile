CC      = gcc
CFLAGS  = -shared -fPIC -O2 -Wall -Wextra -std=c11 -pthread
TARGET  = libapv-engine-fixed.so
SRC     = apv-engine-fixed.c
HDR     = apv-engine-fixed.h

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC) $(HDR)
	$(CC) $(CFLAGS) -o $@ $(SRC)

clean:
	rm -f $(TARGET)
