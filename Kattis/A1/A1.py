#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Created on Mon May 20 14:25:54 2019

@author: fraifeld-mba
"""

import sys
from math import sqrt



def tape_len(n,available):
    a1_perim = sqrt(2)*2*pow(2,-(5/4))+sqrt(2)*2*pow(2,-(3/4))
    current_perim = a1_perim
    covered_perim = 0
    
    required_papers = 1
   
    for i in range(2,n+1):
        
        required_papers = required_papers * 2
        current_perim = current_perim/sqrt(2)
        
        if available[i-2] >= required_papers: 
            
            # we have enough papers at current size
          
            
            covered_perim = covered_perim+required_papers * current_perim
            
            # we add the perimeters of all the papers that make up the a1, but
            # we need to prevent 
            # a) double counting edges taped together
            # b) counting the outside edges of the a1 paper
            
            return((covered_perim-a1_perim)/2)
            
        
        else:
            
            covered_perim  = covered_perim + available[i-2]*current_perim
            required_papers = required_papers -  available[i-2]
    return "impossible"

# read input
i = 0
for line in sys.stdin:
    if i == 0:
        n = int(line)
        i = 1
    else:
        available = [int(x) for x in line.split(" ")]
sys.stdout.write(str(tape_len(n,available))+"\n")