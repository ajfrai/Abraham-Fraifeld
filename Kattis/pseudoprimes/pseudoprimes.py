#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Tue May 21 09:11:25 2019

@author: fraifeld-mba
"""
import sys
import math

def convert(b):
    if b:
        return "yes"
    else:
        return "no"

def perfect_power(n):
    l = math.log(n,2)
    
    for b in range(l):
        a = pow(n,(1/b))
        if a.is_integer():
            return True
    return False

def min_order(n):
    maxk =  math.floor(pow(math.log(n,2),2))
    maxR = max(3, math.ceil(pow(math.log(n,2),5)))
    nextR = True
    r = 1
    while nextR:
        r = r + 1
        nextR = False
        for k in range(1,maxk+1):
            nextR = ((pow(n,k)%r == 1) or pow(n,k)%r == 0)
            if nextR == True:
                break

    return r

def check_divisibility(r, n):
    check = min(r,n-1)
    for a in range(2,check+1):
        if (n/a).is_integer():
            return False
    return True

def check_order(r,n):
    return n <= r        

def totient(n):
    phi = 0
    for i in range(1,n+1):
        if math.gcd(n,i) == 1:
            phi = phi + 1
            
    return phi

def final_check(r,n):
    top = math.floor(math.sqrt(totient(r))*math.log(n,2))
    
    for a in range(1,top+1):
        

def prime(p):
    

def pseudo(a,p):
    return pow(a,p)%p==a%p

for line in sys.stdin:
    line = line.split(" ")
    a = int(line[1])
    p = int(line[0])
    if a == 0 and p ==0:
        break
    
    sys.stdout.write(str(
            convert(pseudo(a,p)))+"\n")
